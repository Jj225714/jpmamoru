// Public runtime settings only. Never include credentials or private workspace state.
window.__RUNTIME_CONFIG__ = {
    managedModelGatewayEnabled: false,
    commercePolicyCatalogUrl: "/public-rules/catalog.json",
    commerceVisualPolicyCatalogUrl: "/public-rules/catalog-visual-v2.json",
    commerceCreativePolicyCatalogUrl: "/public-rules/catalog-creative-v1.json",
    bmModelGatewayEnabled: true,
    gptImageJobsEnabled: false
};
