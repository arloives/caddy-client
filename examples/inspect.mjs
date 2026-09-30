// Read-only: node examples/inspect.mjs [http://localhost:2019]
// Configuration may contain secrets. Be careful where you send this output.
import {CaddyClient} from '../dist/index.js';
const caddy = new CaddyClient({baseUrl:process.argv[2] ?? 'http://localhost:2019'});
const {config,etag} = await caddy.getConfig();
console.log(JSON.stringify({config,etag},null,2));
