const vscode = require('vscode');

function activate(context) {
    console.log('NUDGE SIMPLE IS ACTIVE!');

    // Show immediate notification
    vscode.window.showInformationMessage('🚀 Nudge Simple Extension Activated!');

    // Register a test command
    let disposable = vscode.commands.registerCommand('nudge.testSimple', function () {
        vscode.window.showInformationMessage('Hello from Nudge Simple!');
    });

    context.subscriptions.push(disposable);

    // Auto-show after 1 second
    setTimeout(() => {
        vscode.window.showInformationMessage('⚠️ You have PR reviews pending!');
    }, 1000);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}