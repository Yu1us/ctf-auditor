import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	define: {
		"process.env.NODE_ENV": JSON.stringify("production"),
	},
	build: {
		outDir: resolve(__dirname, "dist"),
		emptyOutDir: true,
		cssCodeSplit: false,
		lib: {
			entry: resolve(__dirname, "src/main.tsx"),
			formats: ["iife"],
			name: "CtfRunFlowViewer",
			fileName: () => "viewer.js",
		},
		rollupOptions: {
			output: {
				assetFileNames: (asset) => asset.name?.endsWith(".css") ? "viewer.css" : "[name][extname]",
				inlineDynamicImports: true,
			},
		},
	},
});
