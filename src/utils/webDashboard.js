/**
 * Renders the HTML for the public web dashboard.
 * Displays high-level bot statistics (guild count, command count,
 * database status, uptime) using Tailwind CSS for styling.
 */

function formatUptime(totalSeconds) {
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor((totalSeconds / 3600) % 24);
  const days = Math.floor(totalSeconds / 86400);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

export function renderDashboardHTML(stats) {
  const {
    botName = 'TitanBot',
    version = '0.0.0',
    guildCount = 0,
    commandCount = 0,
    databaseConnected = false,
    databaseType = 'unknown',
    uptimeSeconds = 0,
  } = stats || {};

  const uptimeFormatted = formatUptime(uptimeSeconds);
  const dbStatusLabel = databaseConnected ? 'Connected' : 'Degraded';
  const dbStatusColor = databaseConnected ? 'text-emerald-400' : 'text-amber-400';
  const dbDotColor = databaseConnected ? 'bg-emerald-400' : 'bg-amber-400';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${botName} Dashboard</title>
  <link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%236366f1"><circle cx="12" cy="12" r="10"/></svg>'
  )}" />
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6">
  <main class="w-full max-w-3xl">
    <div class="flex items-center justify-between mb-8">
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 rounded-xl bg-indigo-500 flex items-center justify-center font-bold text-lg">
          ${botName.charAt(0).toUpperCase()}
        </div>
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">${botName}</h1>
          <p class="text-sm text-slate-400">Version ${version}</p>
        </div>
      </div>
      <span class="inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-slate-300 ring-1 ring-slate-800">
        <span class="h-2 w-2 rounded-full ${dbDotColor}"></span>
        Live
      </span>
    </div>

    <section class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="rounded-2xl bg-slate-900 p-6 ring-1 ring-slate-800">
        <p class="text-sm text-slate-400">Servers</p>
        <p class="mt-2 text-3xl font-bold">${guildCount.toLocaleString()}</p>
      </div>

      <div class="rounded-2xl bg-slate-900 p-6 ring-1 ring-slate-800">
        <p class="text-sm text-slate-400">Total Commands</p>
        <p class="mt-2 text-3xl font-bold">${commandCount.toLocaleString()}</p>
      </div>

      <div class="rounded-2xl bg-slate-900 p-6 ring-1 ring-slate-800">
        <p class="text-sm text-slate-400">Database Status</p>
        <p class="mt-2 text-3xl font-bold ${dbStatusColor}">${dbStatusLabel}</p>
        <p class="mt-1 text-xs text-slate-500">Mode: ${databaseType}</p>
      </div>

      <div class="rounded-2xl bg-slate-900 p-6 ring-1 ring-slate-800">
        <p class="text-sm text-slate-400">Uptime</p>
        <p class="mt-2 text-3xl font-bold">${uptimeFormatted}</p>
      </div>
    </section>

    <footer class="mt-8 text-center text-xs text-slate-500">
      &copy; ${new Date().getFullYear()} ${botName}. Powered by Railway.
    </footer>
  </main>
</body>
</html>`;
}
