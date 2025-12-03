import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import { AzureOpenAI } from 'openai';
import * as path from 'path';
import * as fs from 'fs';

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
            max_tokens: 1024*8
        });

        return response.choices[0]?.message?.content || '';
    } catch (error) {
        vscode.window.showErrorMessage(`OpenAI API 调用失败: ${error}`);
        throw error;
    }
}

/**
 * 获取依赖模块的代码内容
 */
async function getDependencyModulesCode(currentModulePath: string): Promise<string> {
    try {
        const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path');
        if (!aiPath) {
            console.log('[getDependencyModulesCode] AI路径未配置');
            return '';
        }

        // 使用 path.relative 和 path.dirname 来安全地获取项目根路径
        // currentModulePath 是模块目录，需要向上找到项目根目录
        let projectRootPath = currentModulePath;
        
        // 向上查找，直到找到包含 leaf_modules.json 的目录
        let foundLeafModules = false;
        let searchDepth = 0;
        const maxSearchDepth = 10; // 防止无限循环
        
        while (searchDepth < maxSearchDepth) {
            const testPath = path.join(projectRootPath, 'leaf_modules.json');
            if (fs.existsSync(testPath)) {
                foundLeafModules = true;
                break;
            }
            
            const parentPath = path.dirname(projectRootPath);
            if (parentPath === projectRootPath) {
                // 已经到达根目录
                break;
            }
            
            projectRootPath = parentPath;
            searchDepth++;
        }

        if (!foundLeafModules) {
            console.log('[getDependencyModulesCode] 未找到leaf_modules.json文件，从', currentModulePath, '向上搜索');
            return '';
        }

        const leafModulesPath = path.join(projectRootPath, 'leaf_modules.json');
        
        // 读取leaf_modules.json
        const leafModulesContent = fs.readFileSync(leafModulesPath, 'utf-8');
        const leafModules = JSON.parse(leafModulesContent);

        // 获取当前模块名称 - 使用相对路径
        const relativePath = path.relative(aiPath, currentModulePath);
        const currentModuleName = relativePath.split(path.sep).join('.');

        // 找到当前模块
        const currentModule = leafModules.find((mod: any) => mod.module_name === currentModuleName);
        if (!currentModule || !currentModule.dependencies || currentModule.dependencies.length === 0) {
            console.log('[getDependencyModulesCode] 当前模块没有依赖或找不到模块:', currentModuleName);
            return '';
        }

        console.log('[getDependencyModulesCode] 找到', currentModule.dependencies.length, '个依赖模块');

        // 读取所有依赖模块的代码
        let dependenciesCode = '';
        for (const depModuleName of currentModule.dependencies) {
            const depModulePath = path.join(aiPath, ...depModuleName.split('.'));
            const depNodeJsonPath = path.join(depModulePath, 'node.json');

            if (fs.existsSync(depNodeJsonPath)) {
                const nodeData = JSON.parse(fs.readFileSync(depNodeJsonPath, 'utf-8'));
                // 找到最新的活跃节点
                const activeNode = nodeData.find((node: any) => node.isActive);
                if (activeNode && activeNode.filePath && fs.existsSync(activeNode.filePath)) {
                    const depCode = fs.readFileSync(activeNode.filePath, 'utf-8');
                    dependenciesCode += `\n\n=== 依赖模块: ${depModuleName} ===\n${depCode}\n`;
                    console.log('[getDependencyModulesCode] 成功读取依赖模块:', depModuleName);
                } else {
                    console.log('[getDependencyModulesCode] 未找到依赖模块的活跃节点:', depModuleName);
                }
            } else {
                console.log('[getDependencyModulesCode] 未找到依赖模块的node.json:', depNodeJsonPath);
            }
        }

        return dependenciesCode;
    } catch (error) {
        console.error('[getDependencyModulesCode] 获取依赖模块代码失败:', error);
        return '';
    }
}

/**
 * 全局精化提示词 - 对伪代码的全局优化
 */
export async function getGlobalRefinePrompt(fileContent: string, currentModulePath?: string): Promise<{ system: string; user: string }> {
    // 简单的启发式判断：如果去除首尾空格后以 '{' 开头，则视为 JSON 设计文档
    const isJsonDesign = fileContent.trim().startsWith('{');

    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath);
    }

    if (isJsonDesign) {
        // 针对 JSON 设计文档 -> 生成伪代码的 Prompt (使用json2pse_v1.md)
        // 获取扩展根路径 - 使用__dirname向上查找
        let extensionPath = __dirname;
        while (extensionPath && !fs.existsSync(path.join(extensionPath, 'package.json'))) {
            const parent = path.dirname(extensionPath);
            if (parent === extensionPath) {
                break;
            }
            extensionPath = parent;
        }
        
        const json2psePromptPath = path.join(extensionPath, 'resources', 'prompts', 'json2pse_v1.md');
        
        const userPrompt = dependenciesCode 
            ? `请根据以下JSON设计文档生成详细的伪代码：\n\n${fileContent}\n\n以下是该模块依赖的上游模块的伪代码实现，在生成目标模块伪代码时请参考这些依赖模块的函数签名和接口：${dependenciesCode}\n\n请直接返回伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`
            : `请根据以下JSON设计文档生成详细的伪代码：\n\n${fileContent}\n\n请直接返回伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

        if (!fs.existsSync(json2psePromptPath)) {
            console.error('找不到json2pse_v1.md文件:', json2psePromptPath);
            // 回退到简单的系统提示
            return {
                system: `你是一个资深的软件架构师和算法工程师。你的任务是将JSON格式的模块设计文档转换为高质量、结构清晰的伪代码。

请遵循以下规则：
1. **完整性**：生成的伪代码必须严格包含JSON设计文档中的所有信息。
2. **逻辑转换**：将自然语言逻辑步骤准确转换为算法步骤。
3. **错误处理**：设计文档中提到的错误处理必须显式体现在伪代码中。
4. **依赖一致性**：在调用依赖模块时，必须参考提供的上游依赖模块的实际函数签名。

重要：请直接返回生成的完整伪代码内容，不要使用markdown代码块标记，只返回纯文本的伪代码。`,
                user: userPrompt
            };
        }
        const json2psePrompt = fs.readFileSync(json2psePromptPath, 'utf-8');

        return {
            system: json2psePrompt,
            user: userPrompt
        };
    } else {
        // 针对 现有伪代码 -> 优化的 Prompt (保持原有逻辑，稍作微调以适应不同输入风格)
        const userPrompt = dependenciesCode
            ? `请对以下伪代码进行全局精化：\n\n${fileContent}\n\n以下是该模块依赖的上游模块的伪代码实现，在精化时请确保调用依赖模块的函数签名和接口保持一致：${dependenciesCode}\n\n请直接返回改进后的完整伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`
            : `请对以下伪代码进行全局精化：\n\n${fileContent}\n\n请直接返回改进后的完整伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

        return {
            system: `你是一个专业的伪代码审查和优化专家。你的任务是对输入的伪代码进行全局精化，帮助改进其清晰性、逻辑性和完整性。

请对伪代码的以下方面进行优化：
1. 逻辑流程清晰性 - 确保流程步骤清晰、易懂
2. 算法设计 - 优化算法逻辑和流程
3. 结构完整性 - 检查是否有遗漏的步骤或分支
4. 边界条件处理 - 确保处理了所有边界情况
5. 变量和函数命名 - 确保名称清晰能够表达意图
6. 依赖一致性 - 确保调用依赖模块的函数签名正确

重要：请直接返回改进后的完整伪代码内容，不要使用任何markdown代码块标记（如 \`\`\` 或 \`\`\`python 等），不要添加任何额外的格式化标记，只返回纯文本的伪代码内容。`,
            user: userPrompt
        };
    }
}

/**
 * 局部精化提示词 - 对伪代码片段的局部优化
 */
export async function getLocalRefinePrompt(
    fileContent: string,
    startLine: number,
    endLine: number,
    selectedCode: string,
    currentModulePath?: string
): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath);
    }

    const userPrompt = dependenciesCode
        ? `文件完整内容如下：\n\n${fileContent}\n\n用户选中的待精化部分（第 ${startLine} - ${endLine} 行）：\n\n${selectedCode}\n\n以下是该模块依赖的上游模块的伪代码实现，在精化时请确保调用依赖模块的函数签名和接口保持一致：${dependenciesCode}\n\n请对选中部分进行精化，并返回修改后的**完整**伪代码内容。`
        : `文件完整内容如下：\n\n${fileContent}\n\n用户选中的待精化部分（第 ${startLine} - ${endLine} 行）：\n\n${selectedCode}\n\n请对选中部分进行精化，并返回修改后的**完整**伪代码内容。`;

    return {
        system: `你是一个专业的伪代码审查专家。你的任务是对伪代码的特定部分进行局部精化，但必须返回**修改后的完整文件内容**。

请对选中的伪代码片段进行以下方面的优化：
1. **重点优化**：仅针对用户选中的部分（第 ${startLine} 到 ${endLine} 行）进行逻辑、清晰度和完整性的优化。
2. **确保全局一致性**：如果局部修改影响了整体逻辑（如变量名变更、状态依赖、类型变更），请同步修改文件中的相关部分，确保整体逻辑自洽。
3. **检查全局一致性**：检查代码是否本身存在一致性问题（如变量名冲突、状态依赖错误、类型不匹配），并进行相应修正。
4. **依赖一致性**：确保调用依赖模块的函数签名正确。
5. **保持原样**：除非为了满足上述第2、3、4点，否则**绝对不要**修改未选中部分的代码（包括缩进、注释等）。
6. **完整输出**：请输出修改后的**完整伪代码内容**，不要只返回片段。

重要：请直接返回修改后的完整伪代码，不要使用markdown代码块标记（如 \`\`\`），只返回纯文本内容。`,
        user: userPrompt
    };
} 

/**
 * 代码生成提示词 - 从伪代码生成 Python 代码
 */
export async function getGenerateCodePrompt(fileContent: string, lastGranularity: string, language: string = 'python', currentModulePath?: string): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath);
    }

    const userPrompt = dependenciesCode
        ? `以下是伪代码（${lastGranularity || '初始粒度'}）：\n\n${fileContent}\n\n以下是该模块依赖的上游模块的伪代码实现，在生成代码时请确保调用依赖模块的函数签名和接口保持一致：${dependenciesCode}\n\n请根据上述伪代码的整体逻辑生成完整、可运行的 ${language} 代码。代码应完全对应伪代码的逻辑流程。\n\n请直接返回 ${language} 代码，不要使用markdown代码块标记（\`\`\`），只返回纯代码内容。`
        : `以下是伪代码（${lastGranularity || '初始粒度'}）：\n\n${fileContent}\n\n请根据上述伪代码的整体逻辑生成完整、可运行的 ${language} 代码。代码应完全对应伪代码的逻辑流程。\n\n请直接返回 ${language} 代码，不要使用markdown代码块标记（\`\`\`），只返回纯代码内容。`;

    return {
        system: `你是一个专业的 ${language} 代码生成专家。你的任务是根据提供的伪代码生成可运行的 ${language} 代码。

代码生成要求：
1. 根据伪代码的完整逻辑生成可运行的 ${language} 代码
2. 使用适当的 ${language} 数据结构和库
3. 添加必要的错误处理和边界检查
4. 遵循该语言的最佳实践和代码规范
5. 添加清晰的注释对应伪代码步骤
6. 确保调用依赖模块的函数签名正确

重要：请直接返回生成的完整、可运行的 ${language} 代码，不要使用任何markdown代码块标记（如 \`\`\` 或 \`\`\`${language} 等），不要添加任何额外的格式化标记，只返回纯代码。`,
        user: userPrompt
    };
}

export async function getModuleDivisionPrompt1(filePath: string, context: vscode.ExtensionContext): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/非碎片化模块划分.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);
    
    const fileContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    const fileContent = new TextDecoder().decode(fileContentBytes);

    const projectName = path.basename(path.dirname(filePath));
    const userPrompt = `请根据以下原始需求文档进行模块划分：\n\n${fileContent}\n\n项目名称为：${projectName}。你所划分的模块名称应该使用项目名称作为前缀，以确保唯一性。例如，如果项目名称是“a“，则模块名称可以是”a/module1“、“a/module2“等。\n\n
    请直接返回符合要求的 JSON 数组，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    
    return {
        system: systemPrompt,
        user: userPrompt
    };
}

export async function getModuleDivisionPrompt2(modulesPath:string, requirementsPath:string, moduleName: string, context: vscode.ExtensionContext): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/子模块划分.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);

    const modulesContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(modulesPath));
    const modulesContent = new TextDecoder().decode(modulesContentBytes);

    const requirementsContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(requirementsPath));
    const requirementsContent = new TextDecoder().decode(requirementsContentBytes);

    const userPrompt = `原始需求文档：\n${requirementsContent}\n\n当前系统架构（包含所有模块的 JSON 列表）：\n${modulesContent}\n\n待拆解的目标模块名称：\n${moduleName}\n\n请直接返回符合要求的 JSON 数组，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

export async function getCommonDSPrompt(leafModulesPath:string, requirementsPath:string, context: vscode.ExtensionContext): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/通用数据结构提示词.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);

    const modulesContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(leafModulesPath));
    const modulesContent = new TextDecoder().decode(modulesContentBytes);
    
    const requirementsContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(requirementsPath));
    const requirementsContent = new TextDecoder().decode(requirementsContentBytes);
    
    const userPrompt = `原始需求文档：\n${requirementsContent}\n\n当前系统架构（包含所有模块的 JSON 列表）：\n${modulesContent}\n\n请直接返回符合要求的 JSON 数组，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

export async function getLeafModules(leafModulesPath:string, requirementsPath:string, commonDSPath:string, context: vscode.ExtensionContext): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/所有叶子节点生成提示词.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);

    const modulesContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(leafModulesPath));
    const modulesContent = new TextDecoder().decode(modulesContentBytes);
    
    const requirementsContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(requirementsPath));
    const requirementsContent = new TextDecoder().decode(requirementsContentBytes);
    
    const commonDSContentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(commonDSPath));
    const commonDSContent = new TextDecoder().decode(commonDSContentBytes);
    
    const userPrompt = `原始需求文档：\n${requirementsContent}\n\n当前系统架构（包含所有模块的 JSON 列表）：\n${modulesContent}\n\n通用数据结构定义：\n${commonDSContent}\n\n请直接返回符合要求的 JSON 数组，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;
    
    return {
        system: systemPrompt,
        user: userPrompt
    };
}

