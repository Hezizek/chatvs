import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import { AzureOpenAI } from 'openai';
import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import { validateWithSchema } from './schemas';
import { getAzureOpenAIConfig, getAiPath } from '../settings/settings';

dotenv.config();

let openaiClient: AzureOpenAI | undefined;

/**
 * 初始化 Azure OpenAI 客户端
 */
async function initializeOpenAI(): Promise<AzureOpenAI> {
    if (!openaiClient) {
        const { endpoint, apiKey } = await getAzureOpenAIConfig();
        
        openaiClient = new AzureOpenAI({
            endpoint,
            apiKey,
            apiVersion: '2024-02-01'
        });
    }
    return openaiClient;
}

/**
 * 调用 OpenAI 生成结构化输出（JSON 格式），支持 Schema 验证和自动重试
 * @param systemPrompt 系统提示词
 * @param userPrompt 用户提示词
 * @param schema 可选的 Zod schema，用于验证返回的 JSON
 * @param maxRetries 最大重试次数，默认 3 次
 * @returns 生成的文本内容
 */
export async function callOpenAIForJSON<T = any>(
    systemPrompt: string,
    userPrompt: string,
    schema?: z.ZodSchema<T>,
    maxRetries: number = 3
): Promise<string> {
    let lastError: any = null;
    let modifiedUserPrompt = userPrompt;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
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
                        content: modifiedUserPrompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 1024*8
            });

            const content = response.choices[0]?.message?.content || '';
            
            // 如果没有提供 schema，直接返回
            if (!schema) {
                return content;
            }
            
            // 清理 JSON，移除可能的 markdown 标记
            const cleanJson = content.replace(/```json/g, '').replace(/```/g, '').trim();
            
            // 尝试解析 JSON
            let parsedData: any;
            try {
                parsedData = JSON.parse(cleanJson);
            } catch (parseError) {
                console.error(`[callOpenAIForJSON] JSON 解析失败 (第 ${attempt + 1} 次尝试):`, parseError);
                lastError = new Error(`JSON 解析失败: ${parseError}`);
                
                // 如果不是最后一次尝试，继续重试
                if (attempt < maxRetries - 1) {
                    console.log(`[callOpenAIForJSON] 将在下次尝试中要求 LLM 返回有效的 JSON`);
                    // 更新 userPrompt 以强调返回有效 JSON
                    modifiedUserPrompt += `\n\n注意：上一次返回的内容不是有效的 JSON 格式。请确保返回严格符合 JSON 标准的内容，不要包含任何额外的文本或格式标记。`;
                    continue;
                }
                throw lastError;
            }
            
            // 使用 schema 验证
            const validationResult = validateWithSchema(schema, parsedData);
            
            if (validationResult.success) {
                console.log(`[callOpenAIForJSON] Schema 验证通过 (第 ${attempt + 1} 次尝试)`);
                return content;
            } else {
                console.error(`[callOpenAIForJSON] Schema 验证失败 (第 ${attempt + 1} 次尝试):`, validationResult.errors);
                lastError = new Error(`Schema 验证失败: ${validationResult.errors.join('; ')}`);
                
                // 如果不是最后一次尝试，继续重试并提供错误信息
                if (attempt < maxRetries - 1) {
                    console.log(`[callOpenAIForJSON] 将在下次尝试中修正验证错误`);
                    // 更新 userPrompt 以包含验证错误信息
                    modifiedUserPrompt += `\n\n注意：上一次返回的 JSON 不符合要求。验证错误：${validationResult.errors.join('; ')}。请修正这些问题并重新生成。`;
                    continue;
                }
                throw lastError;
            }
        } catch (error) {
            lastError = error;
            console.error(`[callOpenAIForJSON] 调用失败 (第 ${attempt + 1} 次尝试):`, error);
            
            // 如果是最后一次尝试或者是 API 错误（非验证错误），直接抛出
            if (attempt === maxRetries - 1 || (error instanceof Error && error.message.includes('API'))) {
                vscode.window.showErrorMessage(`OpenAI API 调用失败: ${error}`);
                throw error;
            }
        }
    }
    
    // 理论上不会到这里，但为了类型安全
    throw lastError || new Error('未知错误');
}

/**
 * 获取依赖模块的代码内容
 * @param currentModulePath 当前模块路径
 * @param codeType 'pseudocode' 返回伪代码，'actual' 返回实际代码
 */
async function getDependencyModulesCode(currentModulePath: string, codeType: 'pseudocode' | 'actual' = 'pseudocode'): Promise<string> {
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
                
                let targetNode = null;
                
                if (codeType === 'actual') {
                    // 查找最新的实际代码：从后往前找第一个 generated_ 开头的文件
                    for (let i = nodeData.length - 1; i >= 0; i--) {
                        const node = nodeData[i];
                        if (node.filePath) {
                            const fileName = path.basename(node.filePath);
                            if (fileName.startsWith('generated_')) {
                                targetNode = node;
                                break;
                            }
                        }
                    }
                } else {
                    // 查找最后一版伪代码：从后往前找第一个不是 generated_ 开头的文件
                    for (let i = nodeData.length - 1; i >= 0; i--) {
                        const node = nodeData[i];
                        if (node.filePath) {
                            const fileName = path.basename(node.filePath);
                            if (!fileName.startsWith('generated_')) {
                                targetNode = node;
                                break;
                            }
                        }
                    }
                }
                
                if (targetNode && targetNode.filePath && fs.existsSync(targetNode.filePath)) {
                    const depCode = fs.readFileSync(targetNode.filePath, 'utf-8');
                    dependenciesCode += `\n\n=== 依赖模块: ${depModuleName} ===\n${depCode}\n`;
                    console.log(`[getDependencyModulesCode] 成功读取依赖模块的${codeType === 'actual' ? '实际代码' : '伪代码'}:`, depModuleName, '文件:', path.basename(targetNode.filePath));
                } else {
                    console.log(`[getDependencyModulesCode] 未找到依赖模块的${codeType === 'actual' ? '实际代码' : '伪代码'}节点:`, depModuleName);
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
export async function getGlobalRefinePrompt(fileContent: string, currentModulePath?: string, commonDSPath?: string): Promise<{ system: string; user: string }> {
    // 简单的启发式判断：如果去除首尾空格后以 '{' 开头，则视为 JSON 设计文档
    const isJsonDesign = fileContent.trim().startsWith('{');

    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath,'pseudocode');
    }

    // 获取通用数据结构内容（JSON 格式）
    let commonDSContent = '';
    if (commonDSPath && fs.existsSync(commonDSPath)) {
        try {
            commonDSContent = fs.readFileSync(commonDSPath, 'utf-8');
            console.log('[getGlobalRefinePrompt] 成功读取通用数据结构 JSON 文件');
        } catch (error) {
            console.error('读取通用数据结构失败:', error);
        }
    }

    if (isJsonDesign) {
        // 针对 JSON 设计文档 -> 生成伪代码的 Prompt (使用json2pse_v3.md)
        // 获取扩展根路径 - 使用__dirname向上查找
        let extensionPath = __dirname;
        while (extensionPath && !fs.existsSync(path.join(extensionPath, 'package.json'))) {
            const parent = path.dirname(extensionPath);
            if (parent === extensionPath) {
                break;
            }
            extensionPath = parent;
        }
        
        const json2psePromptPath = path.join(extensionPath, 'resources', 'prompts', 'json2pse_v3.md');
        
        let userPrompt = `请根据以下JSON设计文档生成详细的伪代码：\n\n${fileContent}\n\n`;

        if (commonDSContent) {
            userPrompt += `通用数据结构定义（JSON 格式）：\n${commonDSContent}\n\n`;
        }

        if (dependenciesCode) {
            userPrompt += `以下是该模块依赖的上游模块的伪代码实现，在生成目标模块伪代码时请参考这些依赖模块的函数签名和接口：${dependenciesCode}\n\n`;
        }

        userPrompt += `请直接返回伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

        if (!fs.existsSync(json2psePromptPath)) {
            console.error('找不到json2pse_v3.md文件:', json2psePromptPath);
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
            ? `请对以下伪代码进行全局精化：\n\n${fileContent}\n\n**依赖模块的伪代码实现（这些模块已存在，不需要重新实现）**：${dependenciesCode}\n\n**重要说明**：\n- 上面列出的依赖模块已经存在，在精化时只需调用它们，不要修改或重新实现这些依赖模块\n- 请仔细检查当前伪代码中调用依赖模块的地方，确保函数名、参数列表、返回值类型与依赖模块的实际定义完全一致\n- 如果发现调用不一致的地方，请修正\n\n请直接返回改进后的完整伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`
            : `请对以下伪代码进行全局精化：\n\n${fileContent}\n\n请直接返回改进后的完整伪代码，不要使用markdown代码块标记（\`\`\`），只返回纯文本内容。`;

        return {
            system: `你是一个专业的伪代码审查和优化专家。你的任务是对输入的伪代码进行全局精化，帮助改进其清晰性、逻辑性和完整性。

请对伪代码的以下方面进行优化：
1. 逻辑流程清晰性 - 确保流程步骤清晰、易懂
2. 算法设计 - 优化算法逻辑和流程
3. 结构完整性 - 检查是否有遗漏的步骤或分支
4. 边界条件处理 - 确保处理了所有边界情况
5. 变量和函数命名 - 确保名称清晰能够表达意图
6. 依赖一致性 - 如果提供了依赖模块代码，确保调用依赖模块的函数名、参数和返回值与依赖模块的实际定义完全一致

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
    currentModulePath?: string,
    commonDSPath?: string
): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath,'pseudocode');
    }

    // 获取通用数据结构内容（JSON 格式）
    let commonDSContent = '';
    if (commonDSPath && fs.existsSync(commonDSPath)) {
        try {
            commonDSContent = fs.readFileSync(commonDSPath, 'utf-8');
            console.log('[getLocalRefinePrompt] 成功读取通用数据结构 JSON 文件');
        } catch (error) {
            console.error('读取通用数据结构失败:', error);
        }
    }

    let userPrompt = `文件完整内容如下：\n\n${fileContent}\n\n用户选中的待精化部分（第 ${startLine} - ${endLine} 行）：\n\n${selectedCode}\n\n`;
    
    if (commonDSContent) {
        userPrompt += `通用数据结构定义（JSON 格式）：\n${commonDSContent}\n\n`;
    }
    
    if (dependenciesCode) {
        userPrompt += `**依赖模块的伪代码实现（这些模块已存在）**：${dependenciesCode}\n\n**重要说明**：\n- 上面列出的依赖模块已经存在，不需要修改\n- 如果选中部分涉及调用依赖模块，请确保函数名、参数列表、返回值类型与依赖模块的实际定义完全一致\n\n`;
    }
    
    userPrompt += `请对选中部分进行精化，并返回修改后的**完整**伪代码内容。`;

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
 * 代码生成提示词 - 从伪代码生成实际代码
 */
export async function getGenerateCodePrompt(fileContent: string, lastGranularity: string, language: string = 'python', currentModulePath?: string): Promise<{ system: string; user: string }> {
    // 获取依赖模块代码 - 代码生成时需要实际代码
    let dependenciesCode = '';
    if (currentModulePath) {
        dependenciesCode = await getDependencyModulesCode(currentModulePath, 'actual');
    }

    // 获取实际数据结构文件内容
    let actualDataStructureCode = '';
    if (currentModulePath) {
        // 从当前模块路径找到项目根路径
        const aiPath = getAiPath();
        const relativePath = path.relative(aiPath, currentModulePath);
        const pathParts = relativePath.split(path.sep);
        
        if (pathParts.length > 0) {
            const projectRootPath = path.join(aiPath, pathParts[0]);
            
            // 尝试读取实际数据结构文件
            const { getActualDataStructureContent } = await import('../tools/actual-datastructure-generator.js');
            actualDataStructureCode = getActualDataStructureContent(projectRootPath, language);
            
            if (actualDataStructureCode) {
                console.log('[getGenerateCodePrompt] 成功读取实际数据结构文件');
            } else {
                console.log('[getGenerateCodePrompt] 未找到实际数据结构文件');
            }
        }
    }

    // 构建用户提示词
    let userPrompt = `以下是伪代码（${lastGranularity || '初始粒度'}）：\n\n${fileContent}\n\n`;
    
    if (actualDataStructureCode) {
        userPrompt += `**项目的实际数据结构定义（已生成的代码，位于项目根目录的 data_structures.${language === 'python' ? 'py' : language} 文件中）**：\n\n${actualDataStructureCode}\n\n**关于数据结构的重要说明（请务必遵守）**：\n1. 上述数据结构代码**已经存在**于项目根目录的 data_structures 文件中\n2. **绝对禁止**在生成的代码中重新定义或复制这些数据结构的任何部分\n3. 如果需要使用这些数据结构，**必须且只能**通过 import 语句导入\n4. 例如 Python 中应写：from data_structures import ExpressionInput, ParsedExpression, CalculationResult\n5. 导入后直接使用，不要有任何关于数据结构的定义代码\n\n`;
    }
    
    if (dependenciesCode) {
        userPrompt += `**依赖模块代码（这些模块已经实现，请不要重新实现！！！！！）**：${dependenciesCode}\n\n**重要提醒**：\n1. 上面列出的依赖模块已经存在并实现完毕，你只需要 import 它们并调用即可\n2. 请在生成的代码开头添加正确的 import 语句来导入这些依赖模块\n3. **绝对不要**在你生成的代码中重新定义或实现这些依赖模块的类和函数\n4. 调用依赖模块时，请使用它们在伪代码中显示的实际函数签名\n\n`;
    }
    
    userPrompt += `请根据上述伪代码的整体逻辑生成完整、可运行的 ${language} 代码。\n\n请直接返回 ${language} 代码，不要使用markdown代码块标记（\`\`\`），只返回纯代码内容。`;

    return {
        system: `你是一个专业的 ${language} 代码生成专家。你的任务是根据提供的伪代码生成可运行的 ${language} 代码。

代码生成要求：
1. 根据伪代码的完整逻辑生成可运行的 ${language} 代码
2. 使用适当的 ${language} 数据结构和库
3. 添加必要的错误处理和边界检查
4. 遵循该语言的最佳实践和代码规范
5. 添加清晰的注释对应伪代码步骤

**关于数据结构和依赖模块的处理（非常重要）：**
- 如果用户提供了项目的实际数据结构定义，这些数据结构**已经存在**于项目根目录
- 如果用户提供了依赖模块的代码实现，这些模块**已经存在**
- **绝对不要重新实现**这些数据结构或依赖模块的代码
- 必须在代码开头使用 import 语句导入这些数据结构和依赖模块
- 例如：
  - 数据结构：如果 data_structures.py 中定义了 User 类，应该写 "from data_structures import User"
  - 依赖模块：如果依赖模块是 cal.Core，应该写 "from Core import Core" 然后调用 "Core.add()"

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

/**
 * 生成实际数据结构代码的提示词
 * @param commonDSJsonContent common_data_structures.json 的内容
 * @param language 目标编程语言（如 'python', 'java'）
 * @param context VSCode extension context
 * @returns 包含 system 和 user 提示词的对象
 */
export async function getActualDataStructurePrompt(
    commonDSJsonContent: string,
    language: string,
    context: vscode.ExtensionContext
): Promise<{ system: string; user: string }> {
    const systemPromptPath = context.asAbsolutePath('resources/prompts/commonDataStructure.md');
    const systemPromptBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(systemPromptPath));
    const systemPrompt = new TextDecoder().decode(systemPromptBytes);
    
    const userPrompt = `Source JSON（通用数据结构定义）：\n${commonDSJsonContent}\n\nTarget Language: ${language}\n\n请将上述 JSON 定义的所有数据结构转换为 ${language} 语言的纯数据代码。请直接返回代码，不要使用 markdown 代码块标记（如 \`\`\`），只返回纯代码内容。`;
    
    return {
        system: systemPrompt,
        user: userPrompt
    };
}

