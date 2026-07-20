import SwiftUI

struct GraphView: View {
    let store: AppStore
    @SceneStorage("continuum.graph.selectedNode") private var selectedNodeID = ""
    @State private var query = ""
    @State private var selectedKind = "All kinds"
    @State private var selectedRelation = "All relations"
    @State private var points: [String: GraphPoint] = [:]
    @State private var zoom: CGFloat = 1
    @State private var offset = CGSize.zero
    @GestureState private var dragTranslation = CGSize.zero
    @GestureState private var magnification: CGFloat = 1
    @State private var hoveredNodeID: String?

    private var selectedNode: GraphNode? {
        store.graph.nodes.first { $0.id == selectedNodeID }
    }

    private var visibleNodes: [GraphNode] {
        guard selectedKind != "All kinds" else { return store.graph.nodes }
        return store.graph.nodes.filter { $0.kind == selectedKind }
    }

    private var visibleNodeIDs: Set<String> { Set(visibleNodes.map(\.id)) }

    private var visibleEdges: [GraphEdge] {
        store.graph.edges.filter { edge in
            visibleNodeIDs.contains(edge.source)
                && visibleNodeIDs.contains(edge.target)
                && (selectedRelation == "All relations" || edge.relation == selectedRelation)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            controls
            Divider()
            HStack(spacing: 0) {
                graphCanvas
                if let selectedNode {
                    Divider()
                    nodeInspector(selectedNode)
                        .frame(width: 270)
                }
            }
        }
        .task {
            await store.loadGraph()
            await rebuildLayout()
        }
        .onChange(of: store.graph.nodes) {
            Task { await rebuildLayout() }
        }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            TextField("Search graph", text: $query)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 180, idealWidth: 260)
                .onSubmit { runQuery() }

            Picker("Kind", selection: $selectedKind) {
                Text("All kinds").tag("All kinds")
                ForEach(Set(store.graph.nodes.map(\.kind)).sorted(), id: \.self) { kind in
                    Text(kind.capitalized).tag(kind)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 150)

            Picker("Relation", selection: $selectedRelation) {
                Text("All relations").tag("All relations")
                ForEach(Set(store.graph.edges.map(\.relation)).sorted(), id: \.self) { relation in
                    Text(relation.replacingOccurrences(of: "_", with: " ").capitalized).tag(relation)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 170)

            Button("Search", systemImage: "magnifyingglass") { runQuery() }
            Spacer()
            Button("Fit", systemImage: "arrow.up.left.and.arrow.down.right") { resetViewport() }
            Button("Refresh", systemImage: "arrow.clockwise") {
                Task {
                    await store.loadGraph(
                        query: query.isEmpty ? nil : query,
                        nodeKinds: selectedKind == "All kinds" ? [] : [selectedKind],
                        relations: selectedRelation == "All relations" ? [] : [selectedRelation]
                    )
                    await rebuildLayout()
                }
            }
        }
        .padding(12)
    }

    private var graphCanvas: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                Canvas { context, size in
                    let transform = viewportTransform(size: size)
                    for edge in visibleEdges {
                        guard let source = points[edge.source], let target = points[edge.target] else { continue }
                        var path = Path()
                        path.move(to: transform(source))
                        path.addLine(to: transform(target))
                        context.stroke(
                            path,
                            with: .color(.secondary.opacity(0.28)),
                            lineWidth: max(0.6, zoom * magnification)
                        )
                    }

                    for node in visibleNodes {
                        guard let point = points[node.id] else { continue }
                        let location = transform(point)
                        let selected = node.id == selectedNodeID
                        let hovered = node.id == hoveredNodeID
                        let radius = (selected ? 10.5 : hovered ? 9.5 : 7.5) * min(max(zoom * magnification, 0.7), 1.8)
                        let rect = CGRect(
                            x: location.x - radius,
                            y: location.y - radius,
                            width: radius * 2,
                            height: radius * 2
                        )
                        context.fill(Path(ellipseIn: rect), with: .color(color(for: node.kind)))
                        if selected || hovered {
                            context.stroke(Path(ellipseIn: rect.insetBy(dx: -3, dy: -3)), with: .color(.primary.opacity(0.6)), lineWidth: 1.5)
                        }
                        if zoom * magnification > 0.8 || selected || hovered {
                            context.draw(
                                Text(node.label)
                                    .font(.caption2)
                                    .foregroundStyle(.primary),
                                at: CGPoint(x: location.x, y: location.y + radius + 10),
                                anchor: .top
                            )
                        }
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture()
                        .updating($dragTranslation) { value, state, _ in state = value.translation }
                        .onEnded { value in
                            offset.width += value.translation.width
                            offset.height += value.translation.height
                        }
                )
                .simultaneousGesture(
                    MagnificationGesture()
                        .updating($magnification) { value, state, _ in state = value }
                        .onEnded { value in zoom = min(max(zoom * value, 0.35), 3.2) }
                )
                .simultaneousGesture(
                    SpatialTapGesture().onEnded { value in
                        selectedNodeID = nearestNode(to: value.location, size: proxy.size)?.id ?? ""
                    }
                )
                .onContinuousHover { phase in
                    switch phase {
                    case let .active(location): hoveredNodeID = nearestNode(to: location, size: proxy.size)?.id
                    case .ended: hoveredNodeID = nil
                    }
                }

                if store.graph.nodes.isEmpty {
                    ContentUnavailableView(
                        "No graph data yet",
                        systemImage: "point.3.filled.connected.trianglepath.dotted",
                        description: Text("Live checkpoints will populate projects, files, commits, blockers, decisions, and concepts.")
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Label(
                        store.projectionHealth.isReady ? "Projection current" : store.projectionHealth.status.capitalized,
                        systemImage: store.projectionHealth.isReady ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(store.projectionHealth.isReady ? .green : .orange)
                    Text("\(visibleNodes.count) nodes · \(visibleEdges.count) edges")
                        .foregroundStyle(.secondary)
                    if store.graph.truncated {
                        Text("Result capped; narrow the query to see more.")
                            .foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                .padding(10)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9))
                .padding(12)
            }
        }
    }

    private func nodeInspector(_ node: GraphNode) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 5) {
                    Label(node.kind.capitalized, systemImage: nodeIcon(node.kind))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(node.label)
                        .font(.title3.weight(.semibold))
                        .textSelection(.enabled)
                    if let status = node.status {
                        Text(status.capitalized)
                            .font(.caption)
                    }
                }

                Divider()
                Button("Expand one hop", systemImage: "arrow.triangle.branch") {
                    Task {
                        await store.loadGraph(aroundNodeID: node.id, hops: 1)
                        await rebuildLayout()
                    }
                }
                Button("Open in Chat", systemImage: "bubble.left.and.bubble.right") {
                    store.openChat(for: node)
                }

                if !node.provenance.isEmpty {
                    Divider()
                    Text("Provenance")
                        .font(.headline)
                    ForEach(node.provenance) { provenance in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provenance.label ?? "Evidence")
                            if let checkpointID = provenance.checkpointID {
                                Text(checkpointID)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
            }
            .padding(18)
        }
    }

    private func runQuery() {
        Task {
            await store.loadGraph(
                query: query.isEmpty ? nil : query,
                nodeKinds: selectedKind == "All kinds" ? [] : [selectedKind],
                relations: selectedRelation == "All relations" ? [] : [selectedRelation]
            )
            await rebuildLayout()
        }
    }

    private func rebuildLayout() async {
        let nodes = store.graph.nodes
        let edges = store.graph.edges
        points = await Task.detached(priority: .userInitiated) {
            GraphLayoutEngine.layout(nodes: nodes, edges: edges)
        }.value
    }

    private func viewportTransform(size: CGSize) -> (GraphPoint) -> CGPoint {
        let currentZoom = zoom * magnification
        let currentOffset = CGSize(
            width: offset.width + dragTranslation.width,
            height: offset.height + dragTranslation.height
        )
        return { point in
            CGPoint(
                x: size.width / 2 + currentOffset.width + point.x * currentZoom,
                y: size.height / 2 + currentOffset.height + point.y * currentZoom
            )
        }
    }

    private func nearestNode(to location: CGPoint, size: CGSize) -> GraphNode? {
        let transform = viewportTransform(size: size)
        return visibleNodes
            .compactMap { node -> (GraphNode, CGFloat)? in
                guard let point = points[node.id] else { return nil }
                let rendered = transform(point)
                let distance = hypot(rendered.x - location.x, rendered.y - location.y)
                return distance <= 22 ? (node, distance) : nil
            }
            .min(by: { $0.1 < $1.1 })?.0
    }

    private func resetViewport() {
        withAnimation(.easeOut(duration: 0.2)) {
            zoom = 1
            offset = .zero
        }
    }

    private func color(for kind: String) -> Color {
        switch kind.lowercased() {
        case "project": .blue
        case "file": .teal
        case "commit": .purple
        case "blocker", "error": .orange
        case "decision": .green
        case "task": .indigo
        default: .secondary
        }
    }

    private func nodeIcon(_ kind: String) -> String {
        switch kind.lowercased() {
        case "project": "hammer"
        case "file": "doc.text"
        case "commit": "point.3.connected.trianglepath.dotted"
        case "blocker", "error": "exclamationmark.octagon"
        case "decision": "checkmark.diamond"
        case "task": "checklist"
        default: "circle.hexagongrid"
        }
    }
}

struct GraphPoint: Sendable, Equatable {
    var x: CGFloat
    var y: CGFloat
}

enum GraphLayoutEngine {
    static func layout(nodes: [GraphNode], edges: [GraphEdge]) -> [String: GraphPoint] {
        let sortedNodes = nodes.sorted { left, right in
            if left.kind == right.kind { return left.id < right.id }
            return left.kind < right.kind
        }
        guard !sortedNodes.isEmpty else { return [:] }

        let grouped = Dictionary(grouping: sortedNodes, by: \.kind)
        let kinds = grouped.keys.sorted()
        var result: [String: GraphPoint] = [:]
        for (kindIndex, kind) in kinds.enumerated() {
            guard let group = grouped[kind] else { continue }
            let ringRadius = CGFloat(105 + kindIndex * 78)
            for (index, node) in group.enumerated() {
                let seed = stableHash(node.id)
                let phase = Double(seed % 10_000) / 10_000 * .pi * 2
                let angle = phase + Double(index) / Double(max(group.count, 1)) * .pi * 2
                result[node.id] = GraphPoint(
                    x: cos(angle) * ringRadius,
                    y: sin(angle) * ringRadius
                )
            }
        }
        return result
    }

    private static func stableHash(_ value: String) -> UInt64 {
        value.utf8.reduce(UInt64(14_695_981_039_346_656_037)) { partial, byte in
            (partial ^ UInt64(byte)) &* 1_099_511_628_211
        }
    }
}
