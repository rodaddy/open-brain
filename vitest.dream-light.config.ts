import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/maintenance/dream-light-producer.test.ts"],
    fileParallelism: false,
    isolate: true,
    clearMocks: false,
  },
});
