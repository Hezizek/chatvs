import { z } from 'zod';

/**
 * 模块划分的基础 Schema
 * 用于模块划分 API 返回的 JSON 验证
 * 匹配 prompts/非碎片化模块划分.md 和 prompts/子模块划分.md 中定义的 JSON 格式
 * 
 * 必需字段：
 * - name: 模块的全限定名 (PascalCase)，如：a.b
 * - description: 用简练中文描述核心功能和行为
 * - dependencies: 依赖的模块名称列表，无依赖填空数组 []
 */
export const ModuleSchema = z.object({
    name: z.string().min(1, "模块名称(name)不能为空"),
    description: z.string().min(1, "模块描述(description)不能为空"),
    dependencies: z.array(z.string()).default([]),  // 依赖模块列表，默认为空数组
});

/**
 * 模块数组 Schema
 * 用于第一次模块划分和子模块划分
 */
export const ModulesArraySchema = z.array(ModuleSchema).min(1, "至少需要一个模块");

/**
 * 接口定义 Schema
 * 用于叶子模块中的 interfaces 字段
 * 要求每个接口必须有详细的描述，包含具体的逻辑步骤
 */
const InterfaceSchema = z.object({
    name: z.string().min(1, "接口名称(name)不能为空"),
    params: z.string().min(1, "参数列表(params)不能为空"),
    return_type: z.string().min(1, "返回值类型(return_type)不能为空"),
    description: z.string().min(20, "接口描述(description)不能为空，必须包含详细的逻辑步骤（至少20个字符），不能只是简单的一句话概括"),
});

/**
 * 叶子模块 Schema (严格版本)
 * 匹配 prompts/所有叶子节点生成提示词.md 中定义的 JSON 格式
 * 
 * 必需字段：
 * - module_name: 模块的全限定名 (PascalCase)，如：a.b.c
 * - dependencies: 依赖模块名列表
 * - local_variable: 模块内部持有的私有变量/状态列表
 * - interfaces: 函数接口定义数组（普通模块必须至少有一个接口）
 * - entry_point_logic: 仅驱动模块填写，普通模块填 null
 * 
 * 关键约束：
 * - 如果 entry_point_logic 为 null（普通模块），则 interfaces 必须至少有一个接口
 * - 如果 entry_point_logic 不为 null（驱动模块），则可以没有 interfaces
 * - 每个接口的 description 必须包含详细的逻辑步骤描述（至少20个字符）
 */
export const LeafModuleSchema = z.object({
    module_name: z.string().min(1, "模块名称(module_name)不能为空"),
    dependencies: z.array(z.string()).default([]),
    local_variable: z.array(z.string()).default([]),
    interfaces: z.array(InterfaceSchema).default([]),
    entry_point_logic: z.union([z.string().min(20, "入口逻辑(entry_point_logic)不能为空字符串，必须包含详细的逻辑描述（至少20个字符）"), z.null()]).nullable(),
}).refine(
    (data) => {
        // 如果是普通模块（entry_point_logic 为 null），必须至少有一个接口
        if (data.entry_point_logic === null || data.entry_point_logic === '') {
            return data.interfaces.length > 0;
        }
        // 如果是驱动模块（有 entry_point_logic），则可以没有接口
        return true;
    },
    {
        message: "普通模块（entry_point_logic为null）必须至少定义一个接口(interfaces)，且每个接口必须包含详细的逻辑步骤描述。驱动模块必须填写entry_point_logic。",
        path: ["interfaces"],
    }
);

/**
 * 叶子模块数组 Schema
 */
export const LeafModulesArraySchema = z.array(LeafModuleSchema).min(1, "至少需要一个叶子模块");

/**
 * 数据结构属性 Schema
 * 用于通用数据结构中的 attributes 字段
 */
const AttributeSchema = z.object({
    name: z.string().min(1, "属性名称(name)不能为空"),
    description: z.string().min(1, "属性描述(description)不能为空"),
});

/**
 * 通用数据结构 Schema (严格版本)
 * 匹配 prompts/通用数据结构提示词.md 中定义的 JSON 格式
 * 
 * 必需字段：
 * - name: 数据结构名称 (PascalCase)
 * - definition: 简短描述
 * - main_users: 使用该数据的模块名称列表
 * - attributes: 属性列表，每个属性包含 name 和 description
 */
export const DataStructureSchema = z.object({
    name: z.string().min(1, "数据结构名称(name)不能为空"),
    definition: z.string().min(1, "数据结构定义(definition)不能为空"),
    main_users: z.array(z.string()).default([]),
    attributes: z.array(AttributeSchema).min(1, "至少需要一个属性(attributes)"),
});

/**
 * 通用数据结构数组 Schema
 * 必须至少包含一个数据结构
 */
export const DataStructuresArraySchema = z.array(DataStructureSchema).min(1, "至少需要定义一个通用数据结构");

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
