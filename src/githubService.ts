import * as vscode from 'vscode';
import { Octokit } from '@octokit/rest';

export interface PullRequest {
    id: number;
    title: string;
    html_url: string;
    repository: {
        full_name: string;
        name: string;
        owner: {
            login: string;
        };
    };
    user: {
        login: string;
        avatar_url: string;
    };
    created_at: string;
    updated_at: string;
    draft: boolean;
    state: string;
    number: number;
    requested_reviewers: Array<{ login: string }>;
    review_comments: number;
    comments: number;
    additions: number;
    deletions: number;
    labels: Array<{ name: string; color: string }>;
}

export class GitHubService {
    private octokit: Octokit | null = null;
    private lastReviewCount: number = 0;
    private context: vscode.ExtensionContext;
    private cachedPRs: PullRequest[] = [];

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.initialize();
    }

    private async initialize() {
        try {
            await this.authenticate();
        } catch (error) {
            console.error('Failed to initialize GitHub service:', error);
        }
    }

    private async authenticate(): Promise<void> {
        // First, try to use VS Code's built-in GitHub authentication
        try {
            const session = await vscode.authentication.getSession('github', ['repo', 'read:org'], { createIfNone: true });

            if (session) {
                this.octokit = new Octokit({
                    auth: session.accessToken,
                });

                // Test the connection
                const { data: user } = await this.octokit.users.getAuthenticated();
                console.log(`Authenticated as ${user.login}`);

                await vscode.window.showInformationMessage(`Connected to GitHub as ${user.login}`);
                return;
            }
        } catch (error) {
            console.log('VS Code GitHub authentication failed, trying token from settings...', error);
        }

        // Fallback to token from settings
        const config = vscode.workspace.getConfiguration('prReviewReminder');
        const token = config.get<string>('githubToken');

        if (token && token.trim()) {
            this.octokit = new Octokit({
                auth: token,
            });

            try {
                const { data: user } = await this.octokit.users.getAuthenticated();
                console.log(`Authenticated with token as ${user.login}`);
                await vscode.window.showInformationMessage(`Connected to GitHub as ${user.login}`);
            } catch (error) {
                throw new Error('Invalid GitHub token. Please check your settings or use VS Code GitHub authentication.');
            }
        } else {
            // Try to trigger VS Code GitHub authentication
            const session = await vscode.authentication.getSession('github', ['repo', 'read:org'], { createIfNone: true });
            if (session) {
                this.octokit = new Octokit({
                    auth: session.accessToken,
                });
            } else {
                throw new Error('No GitHub authentication available. Please sign in to GitHub or provide a personal access token in settings.');
            }
        }
    }

    async getAssignedPRReviews(): Promise<PullRequest[]> {
        if (!this.octokit) {
            await this.authenticate();
            if (!this.octokit) {
                throw new Error('Not authenticated with GitHub');
            }
        }

        try {
            // Get current user
            const { data: user } = await this.octokit.users.getAuthenticated();

            // Search for PRs where the user is requested as a reviewer
            const searchQuery = `is:pr is:open review-requested:${user.login}`;

            const { data } = await this.octokit.search.issuesAndPullRequests({
                q: searchQuery,
                sort: 'updated',
                order: 'desc',
                per_page: 100
            });

            // Transform the results to include more details
            const prs: PullRequest[] = await Promise.all(
                data.items.map(async (item) => {
                    // Extract repo info from the URL
                    const urlParts = item.repository_url.split('/');
                    const owner = urlParts[urlParts.length - 2];
                    const repo = urlParts[urlParts.length - 1];

                    // Get additional PR details
                    try {
                        const { data: prDetails } = await this.octokit!.pulls.get({
                            owner,
                            repo,
                            pull_number: item.number
                        });

                        return {
                            id: item.id,
                            title: item.title,
                            html_url: item.html_url,
                            repository: {
                                full_name: `${owner}/${repo}`,
                                name: repo,
                                owner: {
                                    login: owner
                                }
                            },
                            user: {
                                login: item.user?.login || 'unknown',
                                avatar_url: item.user?.avatar_url || ''
                            },
                            created_at: item.created_at,
                            updated_at: item.updated_at,
                            draft: prDetails.draft || false,
                            state: item.state,
                            number: item.number,
                            requested_reviewers: prDetails.requested_reviewers || [],
                            review_comments: prDetails.review_comments || 0,
                            comments: prDetails.comments || 0,
                            additions: prDetails.additions || 0,
                            deletions: prDetails.deletions || 0,
                            labels: item.labels || []
                        } as PullRequest;
                    } catch (error) {
                        console.error(`Failed to get details for PR #${item.number}:`, error);
                        // Return basic info if we can't get details
                        return {
                            id: item.id,
                            title: item.title,
                            html_url: item.html_url,
                            repository: {
                                full_name: `${owner}/${repo}`,
                                name: repo,
                                owner: {
                                    login: owner
                                }
                            },
                            user: {
                                login: item.user?.login || 'unknown',
                                avatar_url: item.user?.avatar_url || ''
                            },
                            created_at: item.created_at,
                            updated_at: item.updated_at,
                            draft: false,
                            state: item.state,
                            number: item.number,
                            requested_reviewers: [],
                            review_comments: 0,
                            comments: item.comments || 0,
                            additions: 0,
                            deletions: 0,
                            labels: item.labels || []
                        } as PullRequest;
                    }
                })
            );

            // Always filter out draft PRs
            const filteredPRs = prs.filter(pr => !pr.draft);

            this.cachedPRs = filteredPRs;
            this.lastReviewCount = filteredPRs.length;

            return filteredPRs;
        } catch (error: any) {
            console.error('Failed to fetch PR reviews:', error);
            if (error.status === 401) {
                // Authentication failed, clear the octokit instance
                this.octokit = null;
                throw new Error('GitHub authentication expired. Please re-authenticate.');
            }
            throw error;
        }
    }

    async checkForNewReviews(): Promise<number> {
        const prs = await this.getAssignedPRReviews();
        const currentCount = prs.length;
        const previousCount = this.context.globalState.get<number>('previousReviewCount', 0);

        // Update the stored count
        await this.context.globalState.update('previousReviewCount', currentCount);

        // Return the number of new reviews
        return Math.max(0, currentCount - previousCount);
    }

    getCachedPRs(): PullRequest[] {
        return this.cachedPRs;
    }

    async isAuthenticated(): Promise<boolean> {
        if (!this.octokit) {
            try {
                await this.authenticate();
            } catch {
                return false;
            }
        }

        try {
            await this.octokit!.users.getAuthenticated();
            return true;
        } catch {
            return false;
        }
    }
}