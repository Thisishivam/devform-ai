import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Configuration
const BACKEND_URL = 'https://devform-backend.onrender.com'; // Your Render URL
let userToken: string | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('DevForm AI extension activated');
    
    // Load saved token
    loadUserToken(context);
    
    // Register commands
    const generateCommand = vscode.commands.registerCommand('devform.generate', async () => {
        await generateCode(context);
    });
    
    const statusCommand = vscode.commands.registerCommand('devform.status', async () => {
        await checkUserStatus();
    });
    
    const setTokenCommand = vscode.commands.registerCommand('devform.setToken', async () => {
        await setApiToken(context);
    });
    
    context.subscriptions.push(generateCommand, statusCommand, setTokenCommand);
}

async function loadUserToken(context: vscode.ExtensionContext) {
    try {
        userToken = await context.secrets.get('devformApiToken');
        if (!userToken) {
            // Try config
            const config = vscode.workspace.getConfiguration('devform');
            userToken = config.get('apiToken');
        }
    } catch (error) {
        console.error('Failed to load token:', error);
    }
}

async function setApiToken(context: vscode.ExtensionContext) {
    const token = await vscode.window.showInputBox({
        prompt: 'Enter your DevForm API token',
        placeHolder: 'Get your token from devform.com',
        ignoreFocusOut: true,
        password: true
    });
    
    if (token) {
        userToken = token;
        await context.secrets.store('devformApiToken', token);
        vscode.window.showInformationMessage('✅ API token saved securely');
    }
}

async function generateCode(context: vscode.ExtensionContext) {
    // Check token
    if (!userToken) {
        const setToken = await vscode.window.showWarningMessage(
            'API token required. Get yours from devform.com',
            'Set Token',
            'Cancel'
        );
        
        if (setToken === 'Set Token') {
            await setApiToken(context);
        }
        return;
    }
    
    // Get user prompt
    const prompt = await vscode.window.showInputBox({
        prompt: 'What should I build?',
        placeHolder: 'e.g., "Create a React todo app with Tailwind CSS"',
        ignoreFocusOut: true
    });
    
    if (!prompt) {
        return;
    }
    
    // Get workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('Please open a workspace folder first');
        return;
    }
    
    const workspacePath = workspaceFolders[0].uri.fsPath;
    
    // Show progress
    const progressOptions = {
        location: vscode.ProgressLocation.Notification,
        title: "DevForm AI: Generating code...",
        cancellable: false
    };
    
    try {
        const result = await vscode.window.withProgress(progressOptions, async (progress) => {
            progress.report({ message: 'Analyzing your request...', increment: 10 });
            
            // Call backend
            const response = await callBackend('/generate', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${userToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    prompt: prompt,
                    workspace: workspacePath,
                    max_tokens: 4000,
                    temperature: 0.3
                })
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || `HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            progress.report({ message: 'Processing generated code...', increment: 50 });
            
            // Save the Python script temporarily
            const scriptPath = path.join(workspacePath, '.devform_temp.py');
            const scriptContent = `
import sys
sys.path.insert(0, '${workspacePath}')

from devform_client import DevFormCodeGenerator

if __name__ == "__main__":
    generator = DevFormCodeGenerator(
        user_token="${userToken}",
        workspace_path="${workspacePath}"
    )
    
    # Process the generated content
    print("Processing generated code...")
    # Your script_safe.py logic would go here
    print("Done!")
`;
            
            fs.writeFileSync(scriptPath, scriptContent);
            
            // Create the client module
            const clientPath = path.join(workspacePath, 'devform_client.py');
            // In real implementation, you would bundle your script_safe.py here
            // For now, create a placeholder
            fs.writeFileSync(clientPath, '# DevForm client module - to be replaced with actual script');
            
            progress.report({ message: 'Executing generation...', increment: 80 });
            
            // Run the Python script
            try {
                const { stdout, stderr } = await execAsync(`python "${scriptPath}"`);
                
                // Cleanup
                fs.unlinkSync(scriptPath);
                fs.unlinkSync(clientPath);
                
                return { success: true, data: data, output: stdout };
            } catch (execError) {
                console.error('Python execution error:', execError);
                return { success: false, error: execError };
            }
        });
        
        if (result.success) {
            vscode.window.showInformationMessage(
                `✅ Code generated! Used ${result.data.credits_used} credits. ${result.data.remaining_credits} credits remaining.`
            );
            
            // Refresh file explorer
            vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            
        } else {
            vscode.window.showErrorMessage(`❌ Failed to generate code: ${result.error}`);
        }
        
    } catch (error: any) {
        console.error('Generation error:', error);
        
        if (error.message.includes('401')) {
            vscode.window.showErrorMessage('❌ Invalid API token. Please update your token.');
            userToken = undefined;
            await context.secrets.delete('devformApiToken');
        } else if (error.message.includes('402')) {
            vscode.window.showErrorMessage('❌ Insufficient credits. Upgrade at devform.com');
        } else if (error.message.includes('429')) {
            vscode.window.showErrorMessage('❌ Rate limit exceeded. Free tier: 100 credits/day');
        } else {
            vscode.window.showErrorMessage(`❌ Error: ${error.message}`);
        }
    }
}

async function checkUserStatus() {
    if (!userToken) {
        vscode.window.showWarningMessage('No API token set. Use "DevForm: Set API Token" command');
        return;
    }
    
    try {
        const response = await callBackend('/user/status', {
            headers: {
                'Authorization': `Bearer ${userToken}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        vscode.window.showInformationMessage(
            `DevForm Status:
Email: ${data.email}
Tier: ${data.tier}
Credits: ${data.credits}
Today's usage: ${data.today_usage}`
        );
        
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to get status: ${error.message}`);
    }
}

async function callBackend(endpoint: string, options: RequestInit): Promise<Response> {
    return fetch(`${BACKEND_URL}${endpoint}`, {
        ...options,
        timeout: 60000 // 60 seconds timeout
    } as any);
}

export function deactivate() {
    console.log('DevForm AI extension deactivated');
}