import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('============================================');
    console.log('NUDGE TEST EXTENSION ACTIVATED!!!!');
    console.log('============================================');

    // This should show immediately when extension activates
    vscode.window.showInformationMessage('TEST: Extension is ACTIVE!');

    // Register a simple command
    const disposable = vscode.commands.registerCommand('nudge.test', () => {
        console.log('TEST COMMAND EXECUTED!');
        vscode.window.showInformationMessage('TEST: Command works!');
    });

    context.subscriptions.push(disposable);

    console.log('Commands registered successfully');
}

export function deactivate() {
    vscode.window.showInformationMessage('TEST: Extension deactivated');
}