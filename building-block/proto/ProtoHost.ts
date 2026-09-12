import * as http from 'node:http'
import type { DomainEvent } from '../domain/DomainEvent'

/**
 * 原型宿主：把一个模块组合根里的处理器与内存仓储登记进来，对外开一个很小的 HTTP 口，
 * 让 dev-team 的原型页面（tools/proto.js）能跑命令、看状态、看事件、重置。
 *
 * 不含任何业务概念。它是一次性的壳：生产环境不用它。
 *
 * 用法（src/proto/main.ts）：
 *   const host = new ProtoHost((h) => {
 *     const events = new InMemoryEventPublisher(h)
 *     const accounts = new InMemoryFundingAccountRepository()
 *     h.repository('Funding.FundingAccount', accounts)
 *     h.command('Funding.OpenFundingAccount', (i) => new OpenFundingAccountCommand(String(i.participantId), String(i.quarterStart)), new OpenFundingAccountCommandHandler(accounts, events))
 *     h.query('Funding.GetServiceBudgetAndBalances', (i) => new GetServiceBudgetAndBalancesQuery(String(i.participantId)), new GetServiceBudgetAndBalancesQueryHandler(accounts))
 *   })
 *   host.serve(Number(process.env.PROTO_PORT ?? 4873))
 */
export interface SnapshotRepository {
  /** 内存仓储为原型多提供的一个方法：全部行（纯数据） */
  all(): unknown[] | Promise<unknown[]>
}
type Build = (input: Record<string, unknown>) => unknown
interface Exec { execute(x: unknown): Promise<unknown> }
interface Registration { build: Build; handler: Exec }
export interface EventRecord { at: string; name: string; aggregateId: string; payload: unknown; during: string }
export interface RunResult { ok: boolean; result?: unknown; error?: { name: string; message: string }; events: EventRecord[] }

export class ProtoHost {
  private commands = new Map<string, Registration>()
  private queries = new Map<string, Registration>()
  private repos = new Map<string, SnapshotRepository>()
  private eventLog: EventRecord[] = []
  private current = ''

  constructor(private readonly wire: (host: ProtoHost) => void) {
    this.reset()
  }

  reset(): void {
    this.commands.clear()
    this.queries.clear()
    this.repos.clear()
    this.eventLog = []
    this.wire(this)
  }

  command(name: string, build: Build, handler: Exec): void { this.commands.set(name, { build, handler }) }
  query(name: string, build: Build, handler: Exec): void { this.queries.set(name, { build, handler }) }
  repository(name: string, repo: SnapshotRepository): void { this.repos.set(name, repo) }

  /** 事件总线在发布时调用，原型页面据此显示事件流水 */
  recordEvents(events: DomainEvent[]): void {
    for (const e of events) this.eventLog.push({ at: new Date().toISOString(), name: e.eventName, aggregateId: e.aggregateId, payload: plain(e), during: this.current })
  }

  manifest(): { commands: string[]; queries: string[]; repositories: string[] } {
    return { commands: [...this.commands.keys()], queries: [...this.queries.keys()], repositories: [...this.repos.keys()] }
  }

  async run(kind: 'command' | 'query', name: string, input: Record<string, unknown>): Promise<RunResult> {
    const reg = (kind === 'command' ? this.commands : this.queries).get(name)
    const from = this.eventLog.length
    if (!reg) return { ok: false, error: { name: 'NotRegistered', message: `原型里没有登记 ${kind} ${name}` }, events: [] }
    this.current = name
    try {
      const result = await reg.handler.execute(reg.build(input ?? {}))
      return { ok: true, result: plain(result), events: this.eventLog.slice(from) }
    } catch (e) {
      const err = e as { constructor?: { name?: string }; name?: string; message?: string }
      return { ok: false, error: { name: err?.constructor?.name ?? err?.name ?? 'Error', message: String(err?.message ?? e) }, events: this.eventLog.slice(from) }
    } finally {
      this.current = ''
    }
  }

  async snapshot(): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {}
    for (const [name, repo] of this.repos) out[name] = plain(await repo.all()) as unknown[]
    return out
  }

  events(): EventRecord[] { return this.eventLog }

  serve(port: number): http.Server {
    const json = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
    const server = http.createServer(async (req, res) => {
      const url = (req.url ?? '/').split('?')[0]
      try {
        if (req.method === 'GET' && url === '/manifest') return json(res, 200, this.manifest())
        if (req.method === 'GET' && url === '/state') return json(res, 200, await this.snapshot())
        if (req.method === 'GET' && url === '/events') return json(res, 200, this.events())
        if (req.method === 'POST' && url === '/reset') { this.reset(); return json(res, 200, { ok: true }) }
        if (req.method === 'POST' && url === '/run') {
          let body = ''
          req.on('data', (c) => (body += c))
          req.on('end', async () => {
            try {
              const { kind, name, input } = JSON.parse(body || '{}')
              json(res, 200, await this.run(kind, name, input))
            } catch (e) { json(res, 400, { ok: false, error: { name: 'BadRequest', message: String((e as Error).message) } }) }
          })
          return
        }
        json(res, 404, { error: 'not found' })
      } catch (e) { json(res, 500, { error: String((e as Error).message) }) }
    })
    server.listen(port, '127.0.0.1', () => console.log(`proto host on http://127.0.0.1:${port}`))
    return server
  }
}

/** 变成纯 JSON 数据：Map / Set / Date / 私有字段都摊平，给页面看 */
export function plain(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x, (_k, v) => {
    if (v instanceof Map) return Object.fromEntries(v)
    if (v instanceof Set) return [...v]
    if (typeof v === 'bigint') return v.toString()
    return unwrapProps(v)
  }) ?? 'null')
}

/**
 * 值对象与实体把状态藏在一个叫 props 的私有字段里，直接序列化出来页面上是一层套一层的花括号，
 * 人看不出里面是什么。只有一个 props、别无他物的，把这层包装摘掉，露出里面那几个值。
 * 仓储的行是 { props, version } 两样，不止一个键，摘不到它头上。
 */
function unwrapProps(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const keys = Object.keys(v as object)
  if (keys.length !== 1 || keys[0] !== 'props') return v
  const inner = (v as { props: unknown }).props
  return inner !== null && typeof inner === 'object' ? inner : v
}
