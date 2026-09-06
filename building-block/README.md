# 基础构建块

`src/shared/building-block/` 的源码。新项目由 `tools/new-project.js` 拷入代码库；也可手动复制。

不含任何业务概念——它不是 DDD 的「共享内核」。模块之间不共享业务模型，跨模块只经端口与事件。

```
domain/        AggregateRoot · Entity · ValueObject · DomainEvent · DomainError · ConcurrencyError
application/   NotFoundError · assertFound · DomainEventHandler
ports/         EventPublisherInterface
proto/         ProtoHost · InMemoryEventPublisher（原型宿主，一次性的壳，生产不用）
```

依据：[seed/03-coding-standard.md](../seed/03-coding-standard.md) 第一节。
