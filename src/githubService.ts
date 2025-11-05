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

export interface ReviewEvent {
    prId: number;
    prTitle: string;
    prNumber: number;
    repository: string;
    reviewedAt: string;
    reviewState: string; // APPROVED, CHANGES_REQUESTED, COMMENTED
    prUrl?: string; // URL to the PR on GitHub
}

export interface DailyReviewStats {
    date: string; // YYYY-MM-DD
    count: number;
    reviews: ReviewEvent[];
}

export interface ReviewStats {
    [date: string]: DailyReviewStats;
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
                await vscode.window.showInformationMessage(`Connected to GitHub as ${user.login}`);
                return;
            }
        } catch (error) {
            // VS Code GitHub authentication failed, trying token from settings
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

    /**
     * Query completed reviews from GitHub for the specified date range
     * @param since Optional date to query reviews from (defaults to 90 days ago)
     */
    async getCompletedReviews(since?: Date): Promise<ReviewEvent[]> {
        if (!this.octokit) {
            await this.authenticate();
            if (!this.octokit) {
                throw new Error('Not authenticated with GitHub');
            }
        }

        try {
            // Default to 90 days ago if not specified
            const sinceDate = since || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
            const { data: user } = await this.octokit.users.getAuthenticated();

            // Search for PRs reviewed by the user
            const searchQuery = `is:pr reviewed-by:${user.login} updated:>=${sinceDate.toISOString().split('T')[0]}`;

            const { data } = await this.octokit.search.issuesAndPullRequests({
                q: searchQuery,
                sort: 'updated',
                order: 'desc',
                per_page: 100
            });

            const reviews: ReviewEvent[] = [];

            // Fetch review details for each PR
            for (const item of data.items) {
                try {
                    // Skip PRs authored by the user
                    if (item.user?.login === user.login) {
                        continue;
                    }

                    const urlParts = item.repository_url.split('/');
                    const owner = urlParts[urlParts.length - 2];
                    const repo = urlParts[urlParts.length - 1];

                    // Get reviews submitted by the authenticated user
                    const { data: prReviews } = await this.octokit.pulls.listReviews({
                        owner,
                        repo,
                        pull_number: item.number
                    });

                    // Filter reviews by the authenticated user
                    const userReviews = prReviews.filter(review => review.user?.login === user.login);

                    for (const review of userReviews) {
                        // Only include reviews that have been submitted
                        if (review.submitted_at) {
                            reviews.push({
                                prId: item.id,
                                prTitle: item.title,
                                prNumber: item.number,
                                repository: `${owner}/${repo}`,
                                reviewedAt: review.submitted_at,
                                reviewState: review.state,
                                prUrl: item.html_url
                            });
                        }
                    }
                } catch (error) {
                    console.error(`Failed to get reviews for PR #${item.number}:`, error);
                }
            }

            return reviews;
        } catch (error: any) {
            console.error('Failed to fetch completed reviews:', error);
            throw error;
        }
    }

    /**
     * Get review statistics from local storage
     */
    getReviewStats(): ReviewStats {
        return this.context.globalState.get<ReviewStats>('reviewStats', {});
    }

    /**
     * Get aggregated stats by date range
     */
    getStatsForDateRange(startDate: Date, endDate: Date): { date: string; count: number }[] {
        const stats = this.getReviewStats();
        const result: { date: string; count: number }[] = [];

        const current = new Date(startDate);
        while (current <= endDate) {
            const dateStr = current.toISOString().split('T')[0];
            const dayStat = stats[dateStr];
            result.push({
                date: dateStr,
                count: dayStat?.count || 0
            });
            current.setDate(current.getDate() + 1);
        }

        return result;
    }

    /**
     * Store a review event in local statistics
     */
    async recordReview(review: ReviewEvent): Promise<void> {
        const stats = this.getReviewStats();
        const date = review.reviewedAt.split('T')[0]; // Extract YYYY-MM-DD

        if (!stats[date]) {
            stats[date] = {
                date,
                count: 0,
                reviews: []
            };
        }

        // Check if this review is already recorded (by PR ID and review date)
        const existingReview = stats[date].reviews.find(
            r => r.prId === review.prId && r.reviewedAt === review.reviewedAt
        );

        if (!existingReview) {
            stats[date].reviews.push(review);
            stats[date].count = stats[date].reviews.length;
            await this.context.globalState.update('reviewStats', stats);
        }
    }

    /**
     * Sync recent reviews from GitHub to local storage
     * This should be called periodically to backfill review history
     */
    async syncReviewHistory(daysBack: number = 90): Promise<number> {
        try {
            const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
            const reviews = await this.getCompletedReviews(since);

            // Record all reviews
            for (const review of reviews) {
                await this.recordReview(review);
            }

            return reviews.length;
        } catch (error) {
            console.error('Failed to sync review history:', error);
            throw error;
        }
    }

    /**
     * Get total review count for a date range
     */
    getTotalReviewCount(startDate: Date, endDate: Date): number {
        const stats = this.getStatsForDateRange(startDate, endDate);
        return stats.reduce((sum, day) => sum + day.count, 0);
    }

    /**
     * Mark a PR as reviewed (called when user opens/dismisses a PR)
     */
    async markPRAsReviewed(pr: PullRequest): Promise<void> {
        // Don't track PRs authored by the user - only track PRs they're reviewing
        try {
            const { data: user } = await this.octokit!.users.getAuthenticated();
            if (pr.user.login === user.login) {
                return;
            }
        } catch (error) {
            console.error('Failed to check PR author:', error);
            return;
        }

        const review: ReviewEvent = {
            prId: pr.id,
            prTitle: pr.title,
            prNumber: pr.number,
            repository: pr.repository.full_name,
            reviewedAt: new Date().toISOString(),
            reviewState: 'VIEWED', // Custom state for tracking when user interacted with PR
            prUrl: pr.html_url
        };

        await this.recordReview(review);
    }

    /**
     * Remove a specific PR from review statistics
     */
    async removeReviewByPR(prNumber: number, repository: string): Promise<void> {
        const stats = this.getReviewStats();

        for (const date in stats) {
            const dayStat = stats[date];
            dayStat.reviews = dayStat.reviews.filter(
                review => !(review.prNumber === prNumber && review.repository === repository)
            );
            dayStat.count = dayStat.reviews.length;

            // Remove empty days
            if (dayStat.count === 0) {
                delete stats[date];
            }
        }

        await this.context.globalState.update('reviewStats', stats);
    }

    /**
     * Clean up all local "VIEWED" reviews (which are just click tracking, not real GitHub reviews)
     */
    async cleanupLocalViewedReviews(): Promise<void> {
        const stats = this.getReviewStats();
        let removedCount = 0;

        for (const date in stats) {
            const dayStat = stats[date];
            const beforeCount = dayStat.reviews.length;

            // Keep only reviews from GitHub (not VIEWED state)
            dayStat.reviews = dayStat.reviews.filter(
                review => review.reviewState !== 'VIEWED'
            );

            removedCount += beforeCount - dayStat.reviews.length;
            dayStat.count = dayStat.reviews.length;

            // Remove empty days
            if (dayStat.count === 0) {
                delete stats[date];
            }
        }

        await this.context.globalState.update('reviewStats', stats);
    }

    /**
     * Clear all review statistics and re-sync from GitHub
     */
    async clearAndResync(): Promise<number> {
        // Clear all existing stats
        await this.context.globalState.update('reviewStats', {});

        // Re-sync from GitHub (which now filters out PRs authored by the user)
        const count = await this.syncReviewHistory(90);
        return count;
    }
}