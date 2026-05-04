module.exports = {
  apps: [
    {
      name: "google-flow-mcp",
      script: "dist/index.js",
      interpreter: "node",
      env: {
        PORT: 3000,
      },
    },
  ],
};
