// API base URL for the Worker. Overwritten at deploy time once the
// Worker URL is known. You can also override at runtime:
//   localStorage.setItem('sysmap_api_base', 'https://<worker>.workers.dev')
window.SYSMAP_API_BASE = localStorage.getItem('sysmap_api_base')
  || "https://glenride-system-map-api.mwszghdkkf.workers.dev";
