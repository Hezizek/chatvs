import { z } from 'zod';

/**
 * 模块划分的基础 Schema
 * 用于模块划分 API 返回的 JSON 验证
 * 匹配 prompts/非碎片化模块划分.md 中定义的 JSON 格式
 */
export const ModuleSchema = z.object({
    name: z.string().min(1, "模块名称不能为空"),
    description: z.string().min(1, "模块描述不能为空"),  // 必需字段
    dependencies: z.array(z.string()).optional().default([]),  // 依赖模块列表，可选
}).passthrough();  // 允许额外字段，兼容性更好

/**
 * 模块数组 Schema
 * 用于第一次模块划分和子模块划分
 */
export const ModulesArraySchema = z.array(ModuleSchema).min(1, "至少需要一个模块");

/**
 * 叶子模块 Schema (宽松版本，暂时不做严格验证)
 * 包含更详细的设计信息
 */
export const LeafModuleSchema = z.object({
    module_name: z.string().min(1, "模块名称不能为空"),
    // 其他字段都是可选的，使用 passthrough 允许任意额外字段
}).passthrough();

/**
 * 叶子模块数组 Schema
 */
export const LeafModulesArraySchema = z.array(LeafModuleSchema).min(1, "至少需要一个叶子模块");

/**
 * 通用数据结构 Schema (简化版)
 */
export const DataStructureSchema = z.object({
    name: z.string().min(1, "数据结构名称不能为空"),
    // 其他字段都是可选的
}).passthrough();

/**
 * 通用数据结构数组 Schema
 */
export const DataStructuresArraySchema = z.array(DataStructureSchema);

/**
 * Schema 类型导出
 */
export type Module = z.infer<typeof ModuleSchema>;
export type LeafModule = z.infer<typeof LeafModuleSchema>;
export type DataStructure = z.infer<typeof DataStructureSchema>;

/**
 * Schema 验证辅助函数
 * 返回验证结果和友好的错误信息
 */
export function validateWithSchema<T>(
    schema: z.ZodSchema<T>,
    data: unknown
): { success: true; data: T } | { success: false; errors: string[] } {
    const result = schema.safeParse(data);
    
    if (result.success) {
        return { success: true, data: result.data };
    } else {
        const errors = result.error.errors.map(err => {
            const path = err.path.join('.');
            return `字段 "${path}": ${err.message}`;
        });
        return { success: false, errors };
    }
}

/**
 * 模块名前缀验证函数
 * 用于验证子模块是否以父模块名为前缀
 */
export function validateModulePrefix(modules: Module[], expectedPrefix: string): {
    valid: boolean;
    invalidModules: string[];
} {
    const invalidModules = modules
        .filter(mod => !mod.name.startsWith(expectedPrefix))
        .map(mod => mod.name);
    
    return {
        valid: invalidModules.length === 0,
        invalidModules
    };
}
