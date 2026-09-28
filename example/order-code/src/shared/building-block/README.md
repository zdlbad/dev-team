# 基础构建块

代码库自己的技术基座，跟代码一起提交、在代码库里改。tsconfig 的 `paths` 把 `@shared/building-block/*` 指到这里。新项目由 dev-team 的 `tools/new-project.js --codebase` 从样例代码库 `example/order-code` 拷一份起步。

不含任何业务概念——它不是 DDD 的「共享内核」。模块之间不共享业务模型，跨模块只经端口与事件。

```
domain/        AggregateRoot · Entity · ValueObject · DomainEvent · DomainError · ConcurrencyError
application/   NotFoundError · assertFound · DomainEventHandler
ports/         EventPublisherInterface · EventBusInterface（带订阅）
proto/         ProtoHost · InMemoryEventPublisher（原型宿主，一次性的壳，生产不用）
```

依据：dev-team 的 `agents/code/coding-standard.md`「基础构建块」。
