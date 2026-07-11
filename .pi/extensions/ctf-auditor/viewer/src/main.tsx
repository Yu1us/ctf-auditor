import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	Background,
	Controls,
	MiniMap,
	ReactFlow,
	type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FlowDocument } from "../../run-visualization.ts";
import { buildGraph, type FlowNodeData } from "./graph.ts";
import { Inspector } from "./inspector.tsx";
import { FlowCard } from "./nodes.tsx";
import "./styles.css";

declare global {
	interface Window {
		__CTF_RUN_FLOW__?: FlowDocument;
	}
}

const documentData = window.__CTF_RUN_FLOW__;
if (!documentData) throw new Error("CTF run flow data is missing");

const nodeTypes = { flowCard: FlowCard };

function App({ document }: { document: FlowDocument }): React.JSX.Element {
	const graph = useMemo(() => buildGraph(document), [document]);
	const [selected, setSelected] = useState<FlowNodeData>();
	return <div className="page">
		<header className="topbar">
			<div><span className="eyebrow">CTF RUN</span><h1>{document.run.id}</h1></div>
			<span className={`status variant-${document.run.variant}`}>{document.run.status}</span>
			<p>{document.run.successCriterion}</p>
		</header>
		<main>
			<section className="canvas" aria-label="Run flow graph">
				<ReactFlow
					nodes={graph.nodes}
					edges={graph.edges}
					nodeTypes={nodeTypes}
					fitView
					fitViewOptions={{ padding: 0.18 }}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable
					onNodeClick={(_event, node: Node<FlowNodeData>) => setSelected(node.data)}
					onPaneClick={() => setSelected(undefined)}
				>
					<Background />
					<MiniMap pannable zoomable />
					<Controls showInteractive={false} />
				</ReactFlow>
			</section>
			<Inspector data={selected} warnings={document.warnings} />
		</main>
	</div>;
}

createRoot(document.getElementById("root")!).render(<App document={documentData} />);
