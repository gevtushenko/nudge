const vscode = require('vscode');

function activate(context) {
    console.log('NUDGE IS ACTIVE!');

    // Show immediate notification
    vscode.window.showInformationMessage('🚀 Nudge Extension Activated!');

    // Register the actual commands
    const showReviewsCommand = vscode.commands.registerCommand('nudge.showReviews', async () => {
        vscode.window.showInformationMessage('Opening PR Reviews...');
        // For now, just show a message
        const panel = vscode.window.createWebviewPanel(
            'prReviews',
            'PR Reviews',
            vscode.ViewColumn.One,
            {}
        );
        panel.webview.html = getWebviewContent();
    });

    const refreshCommand = vscode.commands.registerCommand('nudge.refresh', () => {
        vscode.window.showInformationMessage('Refreshing PR Reviews...');
    });

    const dismissCommand = vscode.commands.registerCommand('nudge.dismiss', () => {
        vscode.window.showInformationMessage('Dismissed PR Reviews for this session');
    });

    context.subscriptions.push(showReviewsCommand, refreshCommand, dismissCommand);

    // Auto-show after 2 seconds
    setTimeout(() => {
        vscode.commands.executeCommand('nudge.showReviews');
    }, 2000);
}

function getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PR Reviews</title>
        <style>
            body {
                padding: 20px;
                font-family: sans-serif;
            }
            h1 {
                color: #ff6b6b;
            }
        </style>
    </head>
    <body>
        <h1>⚠️ PR Reviews Pending</h1>
        <p>This is a placeholder. The full GitHub integration would go here.</p>
        <p>For now, this proves the extension is working!</p>
    </body>
    </html>`;
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}