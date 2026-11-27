import { createApp } from "./src/http/app";
import { getPorts } from "./src/ports";

export default createApp(getPorts);
