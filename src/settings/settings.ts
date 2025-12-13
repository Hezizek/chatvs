import * as vscode from "vscode"
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

export const registerCreateSetting = (context: vscode.ExtensionContext) => {
    context.subscriptions.push(
        vscode.commands.registerCommand("CodeToolBox.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "ai")
        })
    )
}

// 用于记录是否已经检查过目录结构
let hasCheckedStructure = false;

/**
 * 获取项目根路径
 */
function getProjectPath(): string {
    const projectPath = vscode.workspace.getConfiguration('ai').get<string>('projectPath')
    if (projectPath) {
        return projectPath
    }
    
    // 回退到旧配置 ai.path
    const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path')
    if (aiPath) {
        return aiPath
    }
    
    vscode.window.showErrorMessage('项目路径未配置，请先在设置中配置 ai.projectPath。')
    throw new Error('项目路径未配置')
}

/**
 * 获取伪代码路径（原 aiPath）
 * 现在返回 projectPath/pseudocodes
 */
export function getAiPath(): string {
    const projectPath = getProjectPath()
    const pseudocodesPath = path.join(projectPath, 'pseudocodes')
    
    // 首次调用时检查目录是否存在
    if (!hasCheckedStructure) {
        checkAndPromptCreateStructure();
    }
    
    return pseudocodesPath
}

/**
 * 获取实际代码路径
 * 返回 projectPath/codes
 */
export function getCodesPath(): string {
    const projectPath = getProjectPath()
    const codesPath = path.join(projectPath, 'codes')
    
    // 首次调用时检查目录是否存在
    if (!hasCheckedStructure) {
        checkAndPromptCreateStructure();
    }
    
    return codesPath
}

/**
 * 检查并提示创建目录结构（异步执行，不阻塞）
 */
function checkAndPromptCreateStructure(): void {
    if (hasCheckedStructure) {
        return;
    }
    
    hasCheckedStructure = true;
    
    // 异步执行检查和创建
    (async () => {
        try {
            const projectPath = getProjectPath();
            const pseudocodesPath = path.join(projectPath, 'pseudocodes');
            const codesPath = path.join(projectPath, 'codes');
            
            const needsCreation: string[] = [];
            
            if (!fs.existsSync(projectPath)) {
                needsCreation.push(`项目根目录: ${projectPath}`);
            }
            if (!fs.existsSync(pseudocodesPath)) {
                needsCreation.push(`伪代码目录: pseudocodes`);
            }
            if (!fs.existsSync(codesPath)) {
                needsCreation.push(`实际代码目录: codes`);
            }
            
            if (needsCreation.length > 0) {
                const message = `检测到以下目录不存在，是否创建？\n${needsCreation.join('\n')}`;
                const answer = await vscode.window.showInformationMessage(
                    message,
                    { modal: true },
                    '创建',
                    '取消'
                );
                
                if (answer === '创建') {
                    // 创建目录
                    if (!fs.existsSync(projectPath)) {
                        fs.mkdirSync(projectPath, { recursive: true });
                    }
                    if (!fs.existsSync(pseudocodesPath)) {
                        fs.mkdirSync(pseudocodesPath, { recursive: true });
                    }
                    if (!fs.existsSync(codesPath)) {
                        fs.mkdirSync(codesPath, { recursive: true });
                    }
                    
                    vscode.window.showInformationMessage('项目结构已创建成功！');
                } else {
                    vscode.window.showWarningMessage('未创建目录结构，某些功能可能无法正常工作。');
                }
            }
        } catch (error) {
            console.error('检查目录结构时出错:', error);
        }
    })();
}

/**
 * 确保项目文件夹结构存在 (codes 和 pseudocodes)
 * 如果不存在则创建，并询问用户
 */
export async function ensureProjectStructure(): Promise<boolean> {
    const projectPath = getProjectPath()
    const pseudocodesPath = getAiPath()
    const codesPath = getCodesPath()
    
    const needsCreation: string[] = []
    
    if (!fs.existsSync(projectPath)) {
        needsCreation.push(`项目根目录: ${projectPath}`)
    }
    if (!fs.existsSync(pseudocodesPath)) {
        needsCreation.push(`伪代码目录: ${pseudocodesPath}`)
    }
    if (!fs.existsSync(codesPath)) {
        needsCreation.push(`实际代码目录: ${codesPath}`)
    }
    
    if (needsCreation.length > 0) {
        const message = `以下目录不存在，是否创建？\n${needsCreation.join('\n')}`
        const answer = await vscode.window.showInformationMessage(
            message,
            { modal: true },
            '创建',
            '取消'
        )
        
        if (answer !== '创建') {
            return false
        }
        
        // 创建目录
        if (!fs.existsSync(projectPath)) {
            fs.mkdirSync(projectPath, { recursive: true })
        }
        if (!fs.existsSync(pseudocodesPath)) {
            fs.mkdirSync(pseudocodesPath, { recursive: true })
        }
        if (!fs.existsSync(codesPath)) {
            fs.mkdirSync(codesPath, { recursive: true })
        }
        
        vscode.window.showInformationMessage('项目结构已创建成功！')
    }
    
    return true
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
