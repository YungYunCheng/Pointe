export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return env.BACKEND.fetch(request);
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;

    /* Explicit SPA fallback in addition to wrangler's asset setting. This
       keeps direct links and browser Back/Forward working after deployments
       even if the asset binding returns a plain 404 for a nested route. */
    if ((request.headers.get("accept") ?? "").includes("text/html")) {
      const index = new URL(request.url);
      index.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(index, request));
    }
    return response;
  },
};
