// src/tools/module-writer.ts
import * as path from 'path';
import * as fs from 'fs';
import { getSrcFileSuffix } from './lang-util';

export async function writeModule(
    projectRoot: string,
    moduleRelativePath: string,
    codeContent: string,
    language: string
): Promise<string> {
    const fileSuffix = getSrcFileSuffix(language) || '.txt';
    
    // 构造目标路径
    const targetFileName = path.basename(moduleRelativePath) + fileSuffix;
    const targetDirRelative = path.dirname(moduleRelativePath);
    
    const targetFileDir = path.join(projectRoot, targetDirRelative);
    const targetFilePath = path.join(targetFileDir, targetFileName);

    // 1. 确保目录存在
    if (!fs.existsSync(targetFileDir)) {
        fs.mkdirSync(targetFileDir, { recursive: true });
    }

    // 2. 写入代码文件
    fs.writeFileSync(targetFilePath, codeContent, 'utf8');

    // 3. 处理 Python __init__.py
    if (language === 'python') {
        let curr = targetFileDir;
        while (curr.startsWith(projectRoot) && curr !== projectRoot) {
            const initFile = path.join(curr, '__init__.py');
            if (!fs.existsSync(initFile)) {
                fs.writeFileSync(initFile, '', 'utf8');
            }
            curr = path.dirname(curr);
        }
    }

    return targetFilePath;
}