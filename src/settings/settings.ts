import * as vscode from "vscode"
import * as dotenv from 'dotenv';

dotenv.config();

export const registerCreateSetting = (context: vscode.ExtensionContext) => {
    context.subscriptions.push(
        vscode.commands.registerCommand("CodeToolBox.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "ai")
        })
    )
}

export function getAiPath(): string {
    const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path')
    if (!aiPath) {
        vscode.window.showErrorMessage('AI 路径未配置，请先在设置中配置 AI 路径。')
        throw new Error('AI 路径未配置')
    }
    return aiPath
}

/**
 * 获取 Azure OpenAI 配置 (Endpoint 和 API Key)
 * 优先从环境变量获取，如果不存在则从 VS Code 设置中获取
 * 如果都未配置，则提示用户输入并保存
 */
export async function getAzureOpenAIConfig(): Promise<{ endpoint: string, apiKey: string }> {
    const config = vscode.workspace.getConfiguration('codeRefinement');
    let endpoint = process.env.AZURE_OPENAI_ENDPOINT || config.get<string>('azureOpenAI.endpoint');
    let apiKey = process.env.AZURE_OPENAI_API_KEY || config.get<string>('azureOpenAI.apiKey');
    
    if (!endpoint || !apiKey) {
        const inputKey = await vscode.window.showInputBox({
            prompt: '请输入你的 Azure OpenAI API Key',
            placeHolder: 'sk-...',
            password: true
        });
        if (!inputKey) {
            throw new Error('API Key 未提供');
        }
        
        const inputEndpoint = await vscode.window.showInputBox({
            prompt: '请输入你的 Azure OpenAI 端点',
            placeHolder: 'https://xxx.openai.azure.com/',
            value: endpoint || 'https://mygavin.openai.azure.com/'
        });
        if (!inputEndpoint) {
            throw new Error('Endpoint 未提供');
        }
        
        // 询问是否保存配置
        const saveConfig = await vscode.window.showQuickPick(['是', '否'], {
            placeHolder: '是否保存配置到设置中？下次无需重复输入'
        });
        
        if (saveConfig === '是') {
            await config.update('azureOpenAI.apiKey', inputKey, vscode.ConfigurationTarget.Global);
            await config.update('azureOpenAI.endpoint', inputEndpoint, vscode.ConfigurationTarget.Global);
        }
        
        apiKey = inputKey;
        endpoint = inputEndpoint;
    }
    
    return { endpoint, apiKey };
}
