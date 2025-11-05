import * as vscode from 'vscode';
import { GitHubService, PullRequest } from './githubService';

export class PRReviewPanel {
    public static currentPanel: PRReviewPanel | undefined;
    public static readonly viewType = 'prReviewPanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionContext: vscode.ExtensionContext;
    private readonly _githubService: GitHubService;
    private _disposables: vscode.Disposable[] = [];

    public static async createOrShow(context: vscode.ExtensionContext, githubService: GitHubService) {
        // If we already have a panel, show it
        if (PRReviewPanel.currentPanel) {
            PRReviewPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            await PRReviewPanel.currentPanel.refresh();
            return;
        }

        // Create a new panel - always in the first column for maximum visibility
        const panel = vscode.window.createWebviewPanel(
            PRReviewPanel.viewType,
            '⚠️ PR Reviews Pending',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri]
            }
        );

        PRReviewPanel.currentPanel = new PRReviewPanel(panel, context, githubService);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        githubService: GitHubService
    ) {
        this._panel = panel;
        this._extensionContext = context;
        this._githubService = githubService;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'openPR':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        // Track that user interacted with this PR
                        if (message.pr) {
                            await this._githubService.markPRAsReviewed(message.pr);
                        }
                        break;
                    case 'checkoutPR':
                        await this.checkoutPR(message.pr);
                        // Track that user interacted with this PR
                        if (message.pr) {
                            await this._githubService.markPRAsReviewed(message.pr);
                        }
                        break;
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'authenticate':
                        await this.authenticate();
                        break;
                    case 'getStats':
                        await this.sendStats();
                        break;
                    case 'syncHistory':
                        await this.syncHistory();
                        break;
                }
            },
            null,
            this._disposables
        );

        // Initial refresh
        this.refresh();
    }

    private async authenticate() {
        try {
            const session = await vscode.authentication.getSession('github', ['repo', 'read:org'], { createIfNone: true });
            if (session) {
                await this.refresh();
            }
        } catch (error) {
            console.error('Authentication failed:', error);
            vscode.window.showErrorMessage('Failed to authenticate with GitHub');
        }
    }

    private async checkoutPR(pr: any) {
        try {
            // Validate PR object
            if (!pr || !pr.html_url) {
                vscode.window.showErrorMessage('Invalid PR data');
                return;
            }

            // Check if we have a workspace open
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                const action = await vscode.window.showWarningMessage(
                    'No workspace folder open. Open the PR in browser instead?',
                    'Open in Browser',
                    'Cancel'
                );
                if (action === 'Open in Browser') {
                    vscode.env.openExternal(vscode.Uri.parse(pr.html_url));
                }
                return;
            }

            const workspaceFolder = vscode.workspace.workspaceFolders[0];

            // Use GitHub CLI to checkout the PR directly
            const ghTerminal = vscode.window.createTerminal('PR Checkout');
            ghTerminal.show();

            // Commands to checkout the PR
            const commands = [
                `cd "${workspaceFolder.uri.fsPath}"`,
                `gh pr checkout ${pr.number}`
            ];

            ghTerminal.sendText(commands.join(' && '));

            vscode.window.showInformationMessage(
                `Checking out PR #${pr.number} using GitHub CLI. Check the terminal for progress.`
            );
        } catch (error: any) {
            console.error('Failed to checkout PR:', error);
            console.error('PR object:', pr);
            vscode.window.showErrorMessage(`Failed to checkout PR: ${error.message}`);
        }
    }

    public async refresh() {
        try {
            // Check if authenticated
            const isAuthenticated = await this._githubService.isAuthenticated();

            if (!isAuthenticated) {
                this._panel.webview.postMessage({
                    command: 'notAuthenticated'
                });
                return;
            }

            // Show loading state
            this._panel.webview.postMessage({ command: 'loading' });

            // Fetch PRs (draft PRs are automatically filtered out)
            const prs = await this._githubService.getAssignedPRReviews();

            // Update the webview
            this._panel.webview.postMessage({
                command: 'updatePRs',
                prs: prs
            });

            // Update the panel title with count - make it attention-grabbing
            if (prs.length > 0) {
                this._panel.title = `⚠️ ${prs.length} PR Review${prs.length > 1 ? 's' : ''} Pending`;
            } else {
                this._panel.title = `✅ No PR Reviews`;
            }

            // Also send stats after refresh
            await this.sendStats();
        } catch (error: any) {
            console.error('Failed to refresh PR reviews:', error);
            this._panel.webview.postMessage({
                command: 'error',
                message: error.message || 'Failed to fetch PR reviews'
            });
        }
    }

    private async sendStats() {
        try {
            // Get the actual review events with details
            const reviewStats = this._githubService.getReviewStats();
            const reviews: any[] = [];

            // Flatten all reviews from all days
            Object.values(reviewStats).forEach((dayStat: any) => {
                dayStat.reviews.forEach((review: any) => {
                    reviews.push(review);
                });
            });

            // Sort by date (oldest to newest)
            reviews.sort((a, b) => new Date(a.reviewedAt).getTime() - new Date(b.reviewedAt).getTime());

            this._panel.webview.postMessage({
                command: 'updateStats',
                stats: {
                    reviews: reviews
                }
            });
        } catch (error) {
            console.error('Failed to send stats:', error);
        }
    }

    private async syncHistory() {
        try {
            this._panel.webview.postMessage({ command: 'syncingHistory' });
            const count = await this._githubService.syncReviewHistory(90);
            vscode.window.showInformationMessage(`Synced ${count} reviews from GitHub`);
            await this.sendStats();
        } catch (error: any) {
            console.error('Failed to sync history:', error);
            vscode.window.showErrorMessage(`Failed to sync review history: ${error.message}`);
        }
    }

    public dispose() {
        PRReviewPanel.currentPanel = undefined;

        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>PR Reviews</title>
            <style>
                body {
                    padding: 10px;
                    margin: 0;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                    font-size: 14px;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }

                .stats-container {
                    margin-bottom: 20px;
                    padding: 12px 16px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 6px;
                }

                .stats-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 16px;
                }

                .stats-title {
                    font-size: 18px;
                    font-weight: 600;
                }

                .sync-btn {
                    padding: 6px 12px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: background-color 0.2s;
                }

                .sync-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .stats-summary {
                    display: flex;
                    gap: 20px;
                    margin-bottom: 16px;
                    flex-wrap: wrap;
                }

                .stat-box {
                    flex: 1;
                    min-width: 120px;
                    padding: 12px;
                    background-color: var(--vscode-editor-background);
                    border-radius: 4px;
                    text-align: center;
                }

                .stat-value {
                    font-size: 28px;
                    font-weight: 700;
                    color: var(--vscode-charts-blue);
                }

                .stat-label {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 4px;
                }

                .chart-container {
                    overflow-x: hidden;
                    width: 100%;
                }

                .contribution-graph {
                    display: flex;
                    gap: 3px;
                    align-items: flex-end;
                    padding: 8px 0;
                    justify-content: flex-end;
                    overflow: visible;
                }

                .date-column {
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    align-items: center;
                    min-width: 14px;
                    flex-shrink: 0;
                }

                .cubes-stack {
                    display: flex;
                    flex-direction: column-reverse;
                    gap: 3px;
                    align-items: center;
                    min-width: 14px;
                    min-height: 14px;
                }

                .review-cube {
                    width: 14px;
                    height: 14px;
                    border-radius: 2px;
                    cursor: pointer;
                    position: relative;
                    transition: all 0.2s;
                    background-color: rgba(48, 161, 78, 0.8);
                    border: 1px solid rgba(27, 31, 35, 0.06);
                    flex-shrink: 0;
                }

                .review-cube:hover {
                    background-color: rgba(33, 110, 57, 1);
                    border: 1px solid rgba(27, 31, 35, 0.3);
                    transform: scale(1.15);
                }

                #global-tooltip {
                    display: none;
                    position: fixed;
                    background-color: var(--vscode-editorHoverWidget-background);
                    border: 1px solid var(--vscode-editorHoverWidget-border);
                    padding: 8px 12px;
                    border-radius: 4px;
                    font-size: 11px;
                    z-index: 999999;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                    max-width: 400px;
                    pointer-events: none;
                    word-wrap: break-word;
                    line-height: 1.4;
                }

                .date-label {
                    font-size: 8px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 6px;
                    white-space: nowrap;
                    text-align: center;
                }

                .review-count {
                    margin-top: 8px;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }


                .pr-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
                    gap: 15px;
                    padding: 0;
                }

                .pr-card {
                    padding: 16px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 6px;
                    transition: all 0.2s;
                }

                .pr-card:hover {
                    background-color: var(--vscode-list-hoverBackground);
                    transform: translateY(-2px);
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                }

                .pr-header {
                    display: flex;
                    align-items: start;
                    gap: 10px;
                    margin-bottom: 12px;
                }

                .pr-icon {
                    font-size: 20px;
                    color: var(--vscode-gitDecoration-untrackedResourceForeground);
                    flex-shrink: 0;
                }

                .pr-title {
                    font-weight: 600;
                    font-size: 16px;
                    line-height: 1.4;
                    flex-grow: 1;
                }

                .pr-repo {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 4px;
                    font-weight: 500;
                }

                .pr-meta {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-top: 12px;
                    padding-top: 12px;
                    border-top: 1px solid var(--vscode-widget-border);
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }

                .pr-meta-info {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 15px;
                }

                .pr-quick-actions {
                    display: flex;
                    gap: 8px;
                }

                .pr-stats {
                    display: flex;
                    gap: 15px;
                    margin-top: 8px;
                }

                .stat {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    font-size: 12px;
                }

                .additions {
                    color: var(--vscode-gitDecoration-addedResourceForeground);
                }

                .deletions {
                    color: var(--vscode-gitDecoration-deletedResourceForeground);
                }

                .comments {
                    color: var(--vscode-descriptionForeground);
                }

                .empty-state {
                    text-align: center;
                    padding: 80px 20px;
                    color: var(--vscode-descriptionForeground);
                }

                .empty-icon {
                    font-size: 64px;
                    margin-bottom: 20px;
                    opacity: 0.3;
                }

                .empty-title {
                    font-size: 20px;
                    margin-bottom: 8px;
                }

                .loading {
                    text-align: center;
                    padding: 80px 20px;
                }

                .spinner {
                    border: 4px solid var(--vscode-widget-border);
                    border-top: 4px solid var(--vscode-focusBorder);
                    border-radius: 50%;
                    width: 50px;
                    height: 50px;
                    animation: spin 1s linear infinite;
                    margin: 0 auto;
                }

                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }

                .error-state {
                    padding: 40px;
                    text-align: center;
                    color: var(--vscode-errorForeground);
                }

                .auth-prompt {
                    padding: 60px;
                    text-align: center;
                }

                .auth-icon {
                    font-size: 64px;
                    opacity: 0.5;
                    margin-bottom: 20px;
                }

                .label {
                    display: inline-block;
                    padding: 3px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: 500;
                    margin-right: 4px;
                }

                .avatar {
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    vertical-align: middle;
                    margin-right: 4px;
                }

                .icon-btn {
                    padding: 4px;
                    border: 1px solid var(--vscode-button-border, transparent);
                    background-color: transparent;
                    color: var(--vscode-foreground);
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 16px;
                    line-height: 1;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 28px;
                    height: 28px;
                }

                .icon-btn:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                    border-color: var(--vscode-button-border, var(--vscode-widget-border));
                }
            </style>
        </head>
        <body>
            <div id="global-tooltip"></div>
            <div id="stats" style="display: none;"></div>
            <div id="content">
                <div class="loading">
                    <div class="spinner"></div>
                    <div style="margin-top: 20px;">Loading PR reviews...</div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }

                function openPR(url, pr) {
                    vscode.postMessage({ command: 'openPR', url: url, pr: pr });
                }

                function syncHistory() {
                    vscode.postMessage({ command: 'syncHistory' });
                }

                function checkoutPR(pr) {
                    vscode.postMessage({ command: 'checkoutPR', pr: pr });
                }

                function authenticate() {
                    vscode.postMessage({ command: 'authenticate' });
                }

                function formatDate(dateString) {
                    const date = new Date(dateString);
                    const now = new Date();
                    const diffMs = now - date;
                    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                    const diffMinutes = Math.floor(diffMs / (1000 * 60));

                    if (diffDays > 0) {
                        return \`\${diffDays} day\${diffDays > 1 ? 's' : ''} ago\`;
                    } else if (diffHours > 0) {
                        return \`\${diffHours} hour\${diffHours > 1 ? 's' : ''} ago\`;
                    } else if (diffMinutes > 0) {
                        return \`\${diffMinutes} minute\${diffMinutes > 1 ? 's' : ''} ago\`;
                    } else {
                        return 'just now';
                    }
                }

                function formatDateShort(dateString) {
                    const date = new Date(dateString);
                    return \`\${date.getMonth() + 1}/\${date.getDate()}\`;
                }

                function formatDateFull(dateString) {
                    const date = new Date(dateString);
                    const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
                    return date.toLocaleDateString(undefined, options);
                }

                function openReviewPR(url) {
                    vscode.postMessage({ command: 'openPR', url: url });
                }

                function showTooltip(event, content) {
                    const tooltip = document.getElementById('global-tooltip');
                    tooltip.innerHTML = content;
                    tooltip.style.display = 'block';

                    // Get the cube's position
                    const cube = event.currentTarget;
                    const rect = cube.getBoundingClientRect();

                    // Position tooltip above the cube
                    const tooltipRect = tooltip.getBoundingClientRect();
                    const left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
                    const top = rect.top - tooltipRect.height - 8; // 8px gap above cube

                    tooltip.style.left = Math.max(8, left) + 'px';
                    tooltip.style.top = Math.max(8, top) + 'px';
                }

                function hideTooltip() {
                    const tooltip = document.getElementById('global-tooltip');
                    tooltip.style.display = 'none';
                }

                function renderStats(stats) {
                    const statsContainer = document.getElementById('stats');

                    if (!stats || !stats.reviews) {
                        statsContainer.style.display = 'none';
                        return;
                    }

                    const reviews = stats.reviews;

                    if (reviews.length === 0) {
                        statsContainer.innerHTML = \`
                            <div class="stats-container">
                                <div class="review-count">No reviews yet.</div>
                            </div>
                        \`;
                        statsContainer.style.display = 'block';
                        return;
                    }

                    // Group reviews by date (convert to local date to avoid timezone issues)
                    const reviewsByDate = {};
                    reviews.forEach(review => {
                        const reviewDate = new Date(review.reviewedAt);
                        const localDateStr = new Date(reviewDate.getTime() - reviewDate.getTimezoneOffset() * 60000)
                            .toISOString().split('T')[0];
                        if (!reviewsByDate[localDateStr]) {
                            reviewsByDate[localDateStr] = [];
                        }
                        reviewsByDate[localDateStr].push(review);
                    });

                    // Calculate how many days we can fit based on window width
                    const bodyWidth = document.body.clientWidth || window.innerWidth;
                    const columnWidth = 17; // 14px cube + 3px gap
                    // Account for stats-container padding (16px * 2) + body padding (10px * 2) + some buffer
                    const padding = 60;
                    const availableWidth = Math.max(bodyWidth - padding, columnWidth * 10); // At least 10 days
                    const numDays = Math.floor(availableWidth / columnWidth);

                    // Always end at today (local date), go back numDays
                    const endDate = new Date();
                    endDate.setHours(23, 59, 59, 999); // End of today
                    const startDate = new Date(endDate);
                    startDate.setDate(startDate.getDate() - numDays + 1);
                    startDate.setHours(0, 0, 0, 0);

                    // Generate all dates in range (using local dates)
                    const dateRange = [];
                    const currentDate = new Date(startDate);
                    while (currentDate <= endDate) {
                        const localDateStr = new Date(currentDate.getTime() - currentDate.getTimezoneOffset() * 60000)
                            .toISOString().split('T')[0];
                        dateRange.push(localDateStr);
                        currentDate.setDate(currentDate.getDate() + 1);
                    }

                    // Generate columns - one per date (including empty ones)
                    const columns = dateRange.map(date => {
                        const dateReviews = reviewsByDate[date] || [];
                        const cubes = dateReviews.map(review => {
                            const url = review.prUrl || \`https://github.com/\${review.repository}/pull/\${review.prNumber}\`;
                            const tooltipContent = \`<strong>\${review.prTitle}</strong><br>\${review.repository} #\${review.prNumber}<br>\${formatDateFull(review.reviewedAt)}\`;
                            return \`
                                <div class="review-cube"
                                     onclick="openReviewPR('\${url}')"
                                     onmouseenter="showTooltip(event, '\${tooltipContent.replace(/'/g, "&apos;")}')"
                                     onmouseleave="hideTooltip()">
                                </div>
                            \`;
                        }).join('');

                        return \`
                            <div class="date-column">
                                <div class="cubes-stack">
                                    \${cubes}
                                </div>
                            </div>
                        \`;
                    }).join('');

                    // Calculate the maximum number of cubes stacked on any single day
                    const maxCubesInDay = Math.max(...Object.values(reviewsByDate).map(r => r.length), 1);
                    const cubeHeight = 14; // px
                    const cubeGap = 3; // px
                    const graphHeight = (maxCubesInDay * cubeHeight) + ((maxCubesInDay - 1) * cubeGap);

                    statsContainer.innerHTML = \`
                        <div class="stats-container">
                            <div class="chart-container">
                                <div class="contribution-graph" style="min-height: \${graphHeight}px; height: \${graphHeight}px;">
                                    \${columns}
                                </div>
                            </div>
                        </div>
                    \`;

                    statsContainer.style.display = 'block';
                }

                function renderPRs(prs) {
                    const content = document.getElementById('content');

                    if (prs.length === 0) {
                        content.innerHTML = \`
                            <div class="empty-state">
                                <div class="empty-icon">✓</div>
                                <div class="empty-title">All caught up!</div>
                                <div>You have no pending PR reviews</div>
                            </div>
                        \`;
                        return;
                    }

                    const prCardsHtml = prs.map(pr => {
                        const labels = pr.labels.map(label =>
                            \`<span class="label" style="background-color: #\${label.color}30; color: #\${label.color};">\${label.name}</span>\`
                        ).join('');

                        return \`
                            <div class="pr-card">
                                <div class="pr-header">
                                    <span class="pr-icon">⇄</span>
                                    <div style="flex-grow: 1;">
                                        <div class="pr-title">
                                            \${pr.title}
                                        </div>
                                        <div class="pr-repo">\${pr.repository.full_name} #\${pr.number}</div>
                                    </div>
                                </div>
                                <div>\${labels}</div>
                                <div class="pr-meta">
                                    <div class="pr-meta-info">
                                        <span>
                                            \${pr.user.avatar_url ? \`<img src="\${pr.user.avatar_url}" class="avatar" />\` : ''}
                                            \${pr.user.login}
                                        </span>
                                        <span>Updated \${formatDate(pr.updated_at)}</span>
                                    </div>
                                    <div class="pr-quick-actions">
                                        <button class="icon-btn" onclick='checkoutPR(\${JSON.stringify(pr).replace(/'/g, "&apos;")})' title="Checkout PR">
                                            ⤵
                                        </button>
                                        <button class="icon-btn" onclick='openPR("\${pr.html_url}", \${JSON.stringify(pr).replace(/'/g, "&apos;")})' title="Open in Browser">
                                            🔗
                                        </button>
                                    </div>
                                </div>
                                <div class="pr-stats">
                                    <span class="stat comments">
                                        💬 \${pr.comments + pr.review_comments} comments
                                    </span>
                                    <span class="stat additions">
                                        +\${pr.additions}
                                    </span>
                                    <span class="stat deletions">
                                        -\${pr.deletions}
                                    </span>
                                </div>
                            </div>
                        \`;
                    }).join('');

                    content.innerHTML = \`<div class="pr-grid">\${prCardsHtml}</div>\`;
                }

                // Store last stats for re-rendering on resize
                let lastStats = null;

                window.addEventListener('message', event => {
                    const message = event.data;

                    switch (message.command) {
                        case 'updatePRs':
                            renderPRs(message.prs);
                            break;
                        case 'updateStats':
                            lastStats = message.stats;
                            renderStats(message.stats);
                            break;
                        case 'syncingHistory':
                            document.getElementById('stats').innerHTML = \`
                                <div class="stats-container">
                                    <div class="loading">
                                        <div class="spinner"></div>
                                        <div style="margin-top: 20px;">Syncing review history from GitHub...</div>
                                    </div>
                                </div>
                            \`;
                            document.getElementById('stats').style.display = 'block';
                            break;
                        case 'loading':
                            document.getElementById('content').innerHTML = \`
                                <div class="loading">
                                    <div class="spinner"></div>
                                    <div style="margin-top: 20px;">Loading PR reviews...</div>
                                </div>
                            \`;
                            break;
                        case 'error':
                            document.getElementById('content').innerHTML = \`
                                <div class="error-state">
                                    <div style="font-size: 48px; margin-bottom: 20px;">⚠️</div>
                                    <div style="font-size: 18px; margin-bottom: 10px;">Error Loading Reviews</div>
                                    <div>\${message.message}</div>
                                    <button class="btn" onclick="refresh()" style="margin-top: 20px;">Try Again</button>
                                </div>
                            \`;
                            break;
                        case 'notAuthenticated':
                            document.getElementById('content').innerHTML = \`
                                <div class="auth-prompt">
                                    <div class="auth-icon">🔐</div>
                                    <div style="font-size: 20px; margin-bottom: 10px;">Authentication Required</div>
                                    <div style="margin-bottom: 20px;">Sign in to GitHub to view your PR reviews</div>
                                    <button class="btn" onclick="authenticate()">
                                        Sign in with GitHub
                                    </button>
                                </div>
                            \`;
                            break;
                    }
                });

                // Re-render stats on window resize to fill the width
                let resizeTimeout;
                window.addEventListener('resize', () => {
                    clearTimeout(resizeTimeout);
                    resizeTimeout = setTimeout(() => {
                        if (lastStats) {
                            // Force a small delay to ensure container has resized
                            requestAnimationFrame(() => {
                                renderStats(lastStats);
                            });
                        }
                    }, 100);
                });
            </script>
        </body>
        </html>`;
    }
}