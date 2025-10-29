import * as vscode from 'vscode';
import { GitHubService } from './githubService';
import { PRReviewPanel } from './prReviewPanel';

let refreshInterval: NodeJS.Timeout | undefined;
let hasShownThisSession = false;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Nudge extension is now active!');

    // Show a message to confirm activation
    vscode.window.showInformationMessage('Nudge extension activated!');

    // Initialize GitHub service
    const githubService = new GitHubService(context);

    // Command to show PR reviews
    const showReviewsCommand = vscode.commands.registerCommand('nudge.showReviews', async () => {
        await PRReviewPanel.createOrShow(context, githubService);
    });

    // Command to refresh PR reviews
    const refreshCommand = vscode.commands.registerCommand('nudge.refresh', async () => {
        if (PRReviewPanel.currentPanel) {
            await PRReviewPanel.currentPanel.refresh();
            vscode.window.showInformationMessage('PR reviews refreshed');
        } else {
            // If panel doesn't exist, create it
            await PRReviewPanel.createOrShow(context, githubService);
        }
    });

    // Command to dismiss for this session
    const dismissCommand = vscode.commands.registerCommand('nudge.dismiss', () => {
        if (PRReviewPanel.currentPanel) {
            PRReviewPanel.currentPanel.dispose();
            hasShownThisSession = true;
            vscode.window.showInformationMessage('PR reviews dismissed for this session');
        }
    });

    context.subscriptions.push(showReviewsCommand, refreshCommand, dismissCommand);

    // Auto-show on startup if enabled
    const config = vscode.workspace.getConfiguration('prReviewReminder');
    const autoShow = config.get<boolean>('autoShowOnStartup', true);
    const onlyShowWhenPRsExist = config.get<boolean>('onlyShowWhenPRsExist', false);

    if (autoShow && !hasShownThisSession) {
        // Small delay to ensure VS Code is fully loaded
        setTimeout(async () => {
            try {
                if (onlyShowWhenPRsExist) {
                    // Check if there are PRs first
                    const isAuthenticated = await githubService.isAuthenticated();
                    if (isAuthenticated) {
                        const prs = await githubService.getAssignedPRReviews();
                        if (prs.length > 0) {
                            await PRReviewPanel.createOrShow(context, githubService);
                            hasShownThisSession = true;

                            // Show a notification about the PRs
                            const message = `You have ${prs.length} PR review${prs.length > 1 ? 's' : ''} waiting for your attention!`;
                            vscode.window.showWarningMessage(message, 'View Details').then(selection => {
                                if (selection === 'View Details' && !PRReviewPanel.currentPanel) {
                                    PRReviewPanel.createOrShow(context, githubService);
                                }
                            });
                        }
                    }
                } else {
                    // Always show on startup
                    await PRReviewPanel.createOrShow(context, githubService);
                    hasShownThisSession = true;
                }
            } catch (error) {
                console.error('Failed to auto-show PR reviews:', error);
            }
        }, 2000); // 2 second delay
    }

    // Set up auto-refresh
    const refreshIntervalMs = config.get<number>('refreshInterval', 300000); // Default: 5 minutes

    if (refreshIntervalMs > 0) {
        refreshInterval = setInterval(async () => {
            // Refresh the panel if it exists
            if (PRReviewPanel.currentPanel) {
                await PRReviewPanel.currentPanel.refresh();
            }

            // Check for new reviews and show notification if enabled
            const showNotifications = config.get<boolean>('showNotifications', true);
            if (showNotifications) {
                const newReviews = await githubService.checkForNewReviews();
                if (newReviews > 0) {
                    const message = `You have ${newReviews} new PR review${newReviews > 1 ? 's' : ''} assigned`;

                    // If panel isn't open, offer to open it
                    if (!PRReviewPanel.currentPanel) {
                        const action = await vscode.window.showWarningMessage(
                            message,
                            'View Reviews'
                        );

                        if (action === 'View Reviews') {
                            await PRReviewPanel.createOrShow(context, githubService);
                        }
                    } else {
                        // Just show info message if panel is already open
                        vscode.window.showInformationMessage(message);
                    }
                }
            }
        }, refreshIntervalMs);
    }

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('prReviewReminder.refreshInterval')) {
                // Clear existing interval
                if (refreshInterval) {
                    clearInterval(refreshInterval);
                }

                // Set up new interval
                const newInterval = vscode.workspace.getConfiguration('prReviewReminder')
                    .get<number>('refreshInterval', 300000);

                if (newInterval > 0) {
                    refreshInterval = setInterval(async () => {
                        if (PRReviewPanel.currentPanel) {
                            await PRReviewPanel.currentPanel.refresh();
                        }
                    }, newInterval);
                }
            }
        })
    );
}

export function deactivate() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
}