// This wrapper ensures the extension loads properly
const vscode = require('vscode');

// Load the compiled TypeScript extension
const mainExtension = require('./out/extension');

function activate(context) {
    console.log('Nudge wrapper activating...');

    // Show immediate feedback
    vscode.window.showInformationMessage('Nudge extension is starting...');

    // Call the real activate function
    try {
        const result = mainExtension.activate(context);
        console.log('Main extension activated successfully');
        return result;
    } catch (error) {
        console.error('Failed to activate main extension:', error);
        vscode.window.showErrorMessage(`Nudge failed to activate: ${error.message}`);
    }
}

function deactivate() {
    if (mainExtension.deactivate) {
        return mainExtension.deactivate();
    }
}

module.exports = {
    activate,
    deactivate
}