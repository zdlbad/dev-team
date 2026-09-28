import { randomUUID } from 'node:crypto'

/**
 * 领域层生成新 id 用这个，别在聚合里直接 import node:crypto：
 * 编码规范「依赖方向」说领域层只 import 同模块领域层与构建块 domain，技术细节收在这里一处。
 */
export function newId(): string {
  return randomUUID()
}
