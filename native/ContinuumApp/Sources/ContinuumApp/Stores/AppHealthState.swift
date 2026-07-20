import Observation

@MainActor
@Observable
final class AppHealthState {
    var connection: EngineConnectionStatus
    var collector: ServiceHealth
    var provider: ProviderHealth
    var retrieval: RetrievalHealth
    var sync: SyncStatus
    var projection: ServiceHealth

    init(
        connection: EngineConnectionStatus = .connecting,
        collector: ServiceHealth = ServiceHealth(status: "starting"),
        provider: ProviderHealth = ProviderHealth(),
        retrieval: RetrievalHealth = RetrievalHealth(),
        sync: SyncStatus = SyncStatus(),
        projection: ServiceHealth = ServiceHealth(status: "unknown")
    ) {
        self.connection = connection
        self.collector = collector
        self.provider = provider
        self.retrieval = retrieval
        self.sync = sync
        self.projection = projection
    }

    var overview: NativeHealthOverview {
        NativeHealthOverview(
            connection: connection,
            collector: collector,
            provider: provider,
            retrieval: retrieval,
            sync: sync,
            projection: projection
        )
    }

    func update(from snapshot: EngineSnapshot) {
        provider = snapshot.provider
        retrieval = snapshot.retrieval
    }
}
