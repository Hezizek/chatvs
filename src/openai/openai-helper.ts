import * as vscode from 'vscode';
import * as dotenv from 'dotenv'
import { AzureOpenAI } from 'openai';

dotenv.config();

let openaiClient: AzureOpenAI | undefined;

/**
 * 初始化 Azure OpenAI 客户端
 */
async function initializeOpenAI(): Promise<AzureOpenAI> {
    if (!openaiClient) {
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
        
        openaiClient = new AzureOpenAI({
            endpoint,
            apiKey,
            apiVersion: '2024-02-01'
        });
    }
    return openaiClient;
}

/**
 * 调用 OpenAI 生成结构化输出（JSON 格式）
 * @param systemPrompt 系统提示词
 * @param userPrompt 用户提示词
 * @returns 生成的文本内容
 */
export async function callOpenAIForJSON(
    systemPrompt: string,
    userPrompt: string
): Promise<string> {
    try {
        const client = await initializeOpenAI();

        const response = await client.chat.completions.create({
            model: 'gpt-35-turbo',
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content: userPrompt
                }
            ],
            temperature: 0.7,
            max_tokens: 2000
        });

        return response.choices[0]?.message?.content || '';
    } catch (error) {
        vscode.window.showErrorMessage(`OpenAI API 调用失败: ${error}`);
        throw error;
    }
}

/**
 * 全局精化提示词 - 对伪代码的全局优化
 */
export function getGlobalRefinePrompt(fileContent: string): { system: string; user: string } {
    // 简单的启发式判断：如果去除首尾空格后以 '{' 开头，则视为 JSON 设计文档
    const isJsonDesign = fileContent.trim().startsWith('{');

    if (isJsonDesign) {
        // 针对 JSON 设计文档 -> 生成伪代码的 Prompt
        return {
            system: `你是一个资深的软件架构师和算法工程师。你的任务是将JSON格式的模块设计文档转换为高质量、结构清晰的伪代码。

请遵循以下规则：
1. **完整性**：生成的伪代码必须严格包含JSON设计文档中的所有信息，包括 \`internal_state\`（作为全局变量或类成员）、\`interfaces\` 中的所有逻辑描述。
2. **逻辑转换**：将 \`description\` 中的自然语言逻辑步骤准确转换为算法步骤。
3. **错误处理**：设计文档中提到的错误处理（如打印stderr、返回null）必须显式体现在伪代码中。
4. **数据结构**：根据文档中的 Set、List 等类型，在伪代码中体现相应的数据结构操作。
5. **命名规范**：保持设计文档中的变量名和函数名一致。

重要：请直接返回生成的完整伪代码内容，不要使用任何markdown代码块标记（如 \`\`\` 或 \`\`\`python 等），不要添加任何额外的解释文本，只返回纯文本的伪代码。`,
            user: `请根据以下JSON设计文档生成详细的伪代码：\n\n${fileContent}\n\n请直接返回伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`
        };
    } else {
        // 针对 现有伪代码 -> 优化的 Prompt (保持原有逻辑，稍作微调以适应不同输入风格)
        return {
            system: `你是一个专业的伪代码审查和优化专家。你的任务是对输入的伪代码进行全局精化，帮助改进其清晰性、逻辑性和完整性。

请对伪代码的以下方面进行优化：
1. 逻辑流程清晰性 - 确保流程步骤清晰、易懂
2. 算法设计 - 优化算法逻辑和流程
3. 结构完整性 - 检查是否有遗漏的步骤或分支
4. 边界条件处理 - 确保处理了所有边界情况
5. 变量和函数命名 - 确保名称清晰能够表达意图

重要：请直接返回改进后的完整伪代码内容，不要使用任何markdown代码块标记（如 \`\`\` 或 \`\`\`python 等），不要添加任何额外的格式化标记，只返回纯文本的伪代码内容。`,
            user: `请对以下伪代码进行全局精化：\n\n${fileContent}\n\n请直接返回改进后的完整伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`
        };
    }
}

/**
 * 局部精化提示词 - 对伪代码片段的局部优化
 */
export function getLocalRefinePrompt(
    fileContent: string,
    startLine: number,
    endLine: number,
    selectedCode: string
): { system: string; user: string } {
    return {
        system: `你是一个专业的伪代码审查专家。你的任务是对伪代码的特定部分进行局部精化，帮助改进其清晰性和逻辑性。

请对选中的伪代码片段进行以下方面的优化：
1. 逻辑清晰性 - 改进步骤描述，使其更易理解
2. 算法优化 - 优化算法流程和逻辑
3. 完整性检查 - 确保没有遗漏步骤
4. 边界条件 - 补充必要的条件判断
5. 表达清晰度 - 改进伪代码的表达方式

重要：请直接返回改进后的伪代码片段，不要使用任何markdown代码块标记（如 \`\`\` 或 \`\`\`python 等），不要添加任何额外的格式化标记，只返回纯文本的伪代码内容。`,
        user: `文件完整伪代码内容（选中部分在第 ${startLine} 到 ${endLine} 行）：\n\n${fileContent}\n\n请对以下选中的伪代码进行局部精化：\n\n${selectedCode}\n\n请直接返回改进后的伪代码片段，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`
    };
}

/**
 * 代码生成提示词 - 从伪代码生成 Python 代码
 */
export function getGenerateCodePrompt(fileContent: string, lastGranularity: string): { system: string; user: string } {
    return {
        system: `你是一个专业的 Python 代码生成专家。你的任务是根据提供的伪代码生成可运行的 Python 代码。

代码生成要求：
1. 根据伪代码的完整逻辑生成可运行的 Python 代码
2. 使用适当的 Python 数据结构和库
3. 添加必要的错误处理和边界检查
4. 遵循 PEP 8 代码规范
5. 添加清晰的注释对应伪代码步骤

重要：请直接返回生成的完整、可运行的 Python 代码，不要使用任何markdown代码块标记（如 \`\`\` 或 \`\`\`python 等），不要添加任何额外的格式化标记，只返回纯 Python 代码。`,
        user: `以下是伪代码（${lastGranularity || '初始粒度'}）：\n\n${fileContent}\n\n请根据上述伪代码的整体逻辑生成完整、可运行的 Python 代码。代码应完全对应伪代码的逻辑流程。\n\n请直接返回 Python 代码，不要使用markdown代码块标记（\`\`\`），只返回纯代码内容。`
    };
}
