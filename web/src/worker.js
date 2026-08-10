export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return env.BACKEND.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
