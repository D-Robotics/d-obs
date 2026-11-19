#!/usr/bin/env node
// Emit (do not save) an explicit native-Moss MCP configuration for this installed copy.
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
export function studioConfig(node=process.execPath){
 const env=Object.fromEntries(['RDK_CAMERA_WORKSHOP_CONFIG','RDK_VISION_COURSE_TRAINING_RECEIPT','RDK_VISION_COURSE_BOARD_ARCHIVE',
   'RDK_VISION_COURSE_PRESET_BOARD_ARCHIVE','RDK_VISION_ROBOGO_TRAINING_PROFILE','RDK_VISION_COURSE_SESSION_DIR','RDK_VISION_COURSE_PREVIOUS_SESSION']
   .filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 if(process.versions.electron) env.ELECTRON_RUN_AS_NODE='1';
 return {mcpServers:{'rdk-vision-workshop':{transport:'stdio',command:node,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],
   ...(Object.keys(env).length?{env}:{}),requestTimeoutMs:30000,
   permissions:{default:'deny',tools:{vision_course_plan:'readonly',vision_course_stage:'readonly',vision_course_next:'readonly',vision_course_view:'readonly',
     vision_course_sync:'approval',vision_course_camera:'approval',vision_course_camera_status:'readonly',vision_course_preflight:'readonly',
     vision_course_isp:'approval',vision_course_isp_status:'readonly'}}}}};
}
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  console.log(JSON.stringify(studioConfig(), null, 2));
}
