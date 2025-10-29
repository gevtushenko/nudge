const vscode = require('vscode');

let currentPanel = undefined;
let githubToken = null;
let cachedPRs = [];

async function activate(context) {
    console.log('Nudge is active!');
    vscode.window.showInformationMessage('🚀 Nudge Extension Activated!');

    // Initialize GitHub authentication
    await initializeGitHub();

    // Register commands
    const showReviewsCommand = vscode.commands.registerCommand('nudge.showReviews', async () => {
        await showPRReviews(context);
    });

    const refreshCommand = vscode.commands.registerCommand('nudge.refresh', async () => {
        if (currentPanel) {
            await updatePanelContent();
            vscode.window.showInformationMessage('PR reviews refreshed');
        } else {
            await showPRReviews(context);
        }
    });

    const dismissCommand = vscode.commands.registerCommand('nudge.dismiss', () => {
        if (currentPanel) {
            currentPanel.dispose();
            currentPanel = undefined;
            vscode.window.showInformationMessage('PR reviews dismissed for this session');
        }
    });

    context.subscriptions.push(showReviewsCommand, refreshCommand, dismissCommand);

    // Auto-show after 2 seconds
    const config = vscode.workspace.getConfiguration('prReviewReminder');
    const autoShow = config.get('autoShowOnStartup', true);

    if (autoShow) {
        setTimeout(async () => {
            await showPRReviews(context);
        }, 2000);
    }
}

async function initializeGitHub() {
    try {
        // Try VS Code's built-in GitHub authentication
        const session = await vscode.authentication.getSession('github', ['repo', 'read:org'], { createIfNone: false });

        if (session) {
            githubToken = session.accessToken;
            console.log('Authenticated with GitHub via VS Code');
            return true;
        }
    } catch (error) {
        console.error('GitHub authentication failed:', error);
    }

    // Check for token in settings
    const config = vscode.workspace.getConfiguration('prReviewReminder');
    const token = config.get('githubToken');

    if (token && token.trim()) {
        githubToken = token;
        return true;
    }

    return false;
}

async function showPRReviews(context) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
    } else {
        currentPanel = vscode.window.createWebviewPanel(
            'prReviews',
            '⚠️ PR Reviews Pending',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
        }, null, context.subscriptions);

        // Handle messages from webview
        currentPanel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'openPR':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'refresh':
                        await updatePanelContent();
                        break;
                    case 'authenticate':
                        await authenticateGitHub();
                        break;
                }
            },
            null,
            context.subscriptions
        );
    }

    await updatePanelContent();
}

async function authenticateGitHub() {
    try {
        const session = await vscode.authentication.getSession('github', ['repo', 'read:org'], { createIfNone: true });
        if (session) {
            githubToken = session.accessToken;
            await updatePanelContent();
        }
    } catch (error) {
        vscode.window.showErrorMessage('Failed to authenticate with GitHub');
    }
}

async function updatePanelContent() {
    if (!currentPanel) return;

    if (!githubToken) {
        currentPanel.webview.html = getAuthenticationHTML();
        return;
    }

    try {
        const prs = await fetchPRReviews();
        cachedPRs = prs;

        currentPanel.title = prs.length > 0
            ? `⚠️ ${prs.length} PR Review${prs.length > 1 ? 's' : ''} Pending`
            : '✅ No PR Reviews';

        currentPanel.webview.html = getWebviewContent(prs);
    } catch (error) {
        console.error('Failed to fetch PRs:', error);
        currentPanel.webview.html = getErrorHTML(error.message);
    }
}

async function fetchPRReviews() {
    if (!githubToken) return [];

    try {
        // First get the authenticated user
        const userResponse = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!userResponse.ok) {
            throw new Error('Failed to authenticate with GitHub');
        }

        const user = await userResponse.json();

        // Search for PRs where user is requested as reviewer
        const searchQuery = `is:pr is:open review-requested:${user.login}`;
        const searchUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&sort=updated&order=desc&per_page=100`;

        const searchResponse = await fetch(searchUrl, {
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!searchResponse.ok) {
            throw new Error('Failed to fetch PR reviews');
        }

        const data = await searchResponse.json();

        return data.items.map(item => ({
            id: item.id,
            title: item.title,
            html_url: item.html_url,
            repository: item.repository_url.split('/').slice(-2).join('/'),
            user: item.user?.login || 'unknown',
            created_at: item.created_at,
            updated_at: item.updated_at,
            number: item.number,
            comments: item.comments || 0,
            labels: item.labels || []
        }));
    } catch (error) {
        console.error('Failed to fetch PRs:', error);
        throw error;
    }
}

function getAuthenticationHTML() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PR Reviews - Authentication Required</title>
        <style>
            body {
                padding: 40px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                text-align: center;
            }
            .auth-container {
                max-width: 500px;
                margin: 100px auto;
            }
            .github-icon {
                font-size: 64px;
                margin-bottom: 20px;
            }
            button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 10px 20px;
                font-size: 16px;
                cursor: pointer;
                border-radius: 4px;
                margin-top: 20px;
            }
            button:hover {
                background: var(--vscode-button-hoverBackground);
            }
        </style>
    </head>
    <body>
        <div class="auth-container">
            <div class="github-icon">🔐</div>
            <h1>Authentication Required</h1>
            <p>Sign in to GitHub to view your PR reviews</p>
            <button onclick="authenticate()">Sign in with GitHub</button>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            function authenticate() {
                vscode.postMessage({ command: 'authenticate' });
            }
        </script>
    </body>
    </html>`;
}

function getErrorHTML(error) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PR Reviews - Error</title>
        <style>
            body {
                padding: 40px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                text-align: center;
            }
            .error-container {
                max-width: 500px;
                margin: 100px auto;
            }
            .error-icon {
                font-size: 64px;
                margin-bottom: 20px;
            }
            button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 10px 20px;
                font-size: 16px;
                cursor: pointer;
                border-radius: 4px;
                margin-top: 20px;
            }
        </style>
    </head>
    <body>
        <div class="error-container">
            <div class="error-icon">⚠️</div>
            <h1>Error Loading Reviews</h1>
            <p>${error}</p>
            <button onclick="refresh()">Try Again</button>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            function refresh() {
                vscode.postMessage({ command: 'refresh' });
            }
        </script>
    </body>
    </html>`;
}

function getWebviewContent(prs) {
    const prListHTML = prs.length === 0
        ? '<div class="empty-state">✅ No PR reviews assigned to you</div>'
        : prs.map(pr => `
            <div class="pr-card" onclick="openPR('${pr.html_url}')">
                <div class="pr-title">${escapeHtml(pr.title)}</div>
                <div class="pr-meta">
                    <span class="pr-repo">${escapeHtml(pr.repository)} #${pr.number}</span>
                    <span>by ${escapeHtml(pr.user)}</span>
                    <span>${formatDate(pr.updated_at)}</span>
                </div>
                <div class="pr-stats">
                    <span>💬 ${pr.comments} comments</span>
                </div>
            </div>
        `).join('');

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PR Reviews</title>
        <style>
            body {
                padding: 0;
                margin: 0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
            }
            .header {
                padding: 20px;
                background: linear-gradient(135deg, #ff6b6b, #ff8e8e);
                color: white;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .header h1 {
                margin: 0;
                font-size: 24px;
            }
            .refresh-btn {
                background: rgba(255, 255, 255, 0.2);
                border: 1px solid rgba(255, 255, 255, 0.3);
                color: white;
                padding: 8px 16px;
                cursor: pointer;
                border-radius: 4px;
                font-size: 14px;
                border: none;
            }
            .refresh-btn:hover {
                background: rgba(255, 255, 255, 0.3);
            }
            .container {
                padding: 20px;
            }
            .pr-card {
                background: var(--vscode-editor-inactiveSelectionBackground);
                padding: 15px;
                margin-bottom: 10px;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s;
                border: 1px solid transparent;
            }
            .pr-card:hover {
                transform: translateX(5px);
                background: var(--vscode-list-hoverBackground);
                border-color: var(--vscode-focusBorder);
            }
            .pr-title {
                font-weight: 600;
                font-size: 16px;
                margin-bottom: 8px;
                color: var(--vscode-editor-foreground);
            }
            .pr-meta {
                font-size: 13px;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 5px;
            }
            .pr-meta span {
                margin-right: 15px;
            }
            .pr-repo {
                font-weight: 500;
                color: var(--vscode-textLink-foreground);
            }
            .pr-stats {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
            }
            .empty-state {
                text-align: center;
                padding: 80px 20px;
                font-size: 20px;
                color: var(--vscode-descriptionForeground);
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>📋 Pull Request Reviews</h1>
            <button class="refresh-btn" onclick="refresh()">↻ Refresh</button>
        </div>
        <div class="container">
            ${prListHTML}
        </div>
        <script>
            const vscode = acquireVsCodeApi();

            function openPR(url) {
                vscode.postMessage({ command: 'openPR', url: url });
            }

            function refresh() {
                vscode.postMessage({ command: 'refresh' });
            }
        </script>
    </body>
    </html>`;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffDays > 0) {
        return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else if (diffHours > 0) {
        return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else if (diffMinutes > 0) {
        return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
    } else {
        return 'just now';
    }
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}