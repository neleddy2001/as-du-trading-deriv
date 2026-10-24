# Deriv MCP — As Du Trading

Serveur MCP privé qui donne à Claude les bougies et les prix Deriv (forex, or, pétrole, crypto).
Hébergé sur Netlify (fonction `netlify/functions/mcp.mjs`).

- URL du connecteur : `https://as-du-trading-deriv.netlify.app/mcp/<MCP_PATH_TOKEN>`
- Variables d'environnement Netlify : `MCP_PATH_TOKEN` (secret, obligatoire), `DERIV_APP_ID` (facultatif, 1089 par défaut).
- Outils : `get_market_structure`, `get_candles`, `get_multi_timeframe`, `get_prices`, `list_symbols` (lecture seule).
- Test rapide dans un navigateur : ouvrir l'URL du connecteur avec `?symbol=GBPUSD&tf=H1`.
