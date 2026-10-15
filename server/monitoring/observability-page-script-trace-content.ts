import { TRACE_CONTENT_RENDER_DEFAULTS } from './observability-page-trace-content-types.js';

/** Scoped plain-text components; existing render functions remain compatible. */
export const OPS_OBSERVABILITY_SCRIPT_TRACE_CONTENT = String.raw`
      const traceContentDefaults=${JSON.stringify(TRACE_CONTENT_RENDER_DEFAULTS)};
      function traceContentOptions(value){
        const options=Object.assign({},traceContentDefaults,value&&typeof value==='object'?value:{});
        const limit=Number(options.previewCharacters);
        options.previewCharacters=Number.isFinite(limit)?Math.max(80,Math.min(4000,Math.floor(limit))):traceContentDefaults.previewCharacters;
        const depth=Number(options.maxJsonDepth),length=Number(options.maxFormattedCharacters);
        options.maxJsonDepth=Number.isFinite(depth)?Math.max(2,Math.min(64,Math.floor(depth))):traceContentDefaults.maxJsonDepth;
        options.maxFormattedCharacters=Number.isFinite(length)?Math.max(256,Math.min(65536,Math.floor(length))):traceContentDefaults.maxFormattedCharacters;
        return options;
      }
      function traceContentKindName(kind){return ({user_input:'用户输入',model_input:'模型实际输入（含上下文）',model_output:'模型回复',tool_input:'工具输入',tool_output:'工具输出'})[String(kind||'')]||''}
      function traceContentRoleName(entry,source,options){
        if(options.roleLabel)return String(options.roleLabel);
        if(entry.kind==='tool_input')return '工具调用 · 参数';
        if(entry.kind==='tool_output')return '工具调用 · 结果';
        if(entry.kind==='model_output'){
          try{
            const value=JSON.parse(entry.text),blocks=Array.isArray(value)?value:value&&Array.isArray(value.content)?value.content:[];
            if(value&&(value.stopReason==='tool_use'||value.stop_reason==='tool_use')||blocks.some(block=>block&&block.type==='tool_use'))return '模型调用工具';
          }catch(_error){}
        }
        return traceContentKindName(entry.kind);
      }
      function traceContentState(span){
        const content=span&&span.content;
        if(!content||content.availability==='not_captured')return {availability:'not_captured',entries:[]};
        if(content.availability!=='available')return {availability:content.availability==='expired'?'expired':'unavailable',entries:[]};
        if(content.schema!=='rdk.studio.trace-content.v1'||!Array.isArray(content.entries))return {availability:'unavailable',entries:[]};
        return {availability:'available',entries:content.entries.filter(entry=>entry&&traceContentKindName(entry.kind)&&typeof entry.text==='string'),truncated:content.truncated===true,redacted:content.redacted===true};
      }
      function traceContentAvailabilityName(value){return ({available:'已采集',not_captured:'未采集',expired:'已过保留期',unavailable:'暂不可用'})[String(value||'')]||'暂不可用'}
      function traceContentAvailabilityHint(value){return ({not_captured:'该片段未采集正文，历史内容无法补回。',expired:'正文已过保留期，当前仅保留链路指标。',unavailable:'正文暂不可用，请稍后重新读取运行详情。'})[String(value||'')]||'该片段返回的正文为空。'}
      function renderTraceContentFlags(parent,content){
        if(content&&content.redacted)add(parent,'span','trace-content-badge','已脱敏');
        if(content&&content.truncated)add(parent,'span','trace-content-badge warning','已截断');
      }
      function traceContentDisclosure(node,key){node.setAttribute('data-trace-disclosure-key',key);return node}
      function traceContentTextNode(text,isJson,key){
        const node=make(isJson?'pre':'div',isJson?'trace-content-text trace-content-json':'trace-content-prose');
        node.setAttribute('data-trace-scroll-key',key);
        if(isJson){node.textContent=text;node.tabIndex=0;node.setAttribute('aria-label','JSON 正文，纯文本');node.setAttribute('data-trace-focus-key',key)}
        else text.split(/\n{2,}/).forEach(paragraph=>add(node,'p','trace-content-paragraph',paragraph));
        return node;
      }
      function traceContentPrettyJson(text,options){
        const output=[];let length=0,depth=0,quoted=false,escaped=false,last='';
        const append=value=>{length+=value.length;if(length>options.maxFormattedCharacters)return false;output.push(value);return true};
        const line=()=>append('\n'+'  '.repeat(depth));
        for(let index=0;index<text.length;index++){
          const char=text[index];
          if(quoted){if(!append(char))return null;if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"'){quoted=false;last='"'};continue}
          if(/\s/.test(char))continue;
          if(char==='"'){quoted=true;if(!append(char))return null;continue}
          if(char==='{'||char==='['){
            depth+=1;if(depth>options.maxJsonDepth||!append(char))return null;
            let next=index+1;while(next<text.length&&/\s/.test(text[next]))next+=1;
            if(text[next]!=='}'&&text[next]!==']'&&!line())return null;
          }else if(char==='}'||char===']'){
            depth-=1;if(last!=='{'&&last!=='['&&!line())return null;if(!append(char))return null;
          }else if(char===','){if(!append(char)||!line())return null}
          else if(char===':'){if(!append(': '))return null}
          else if(!append(char))return null;
          last=char;
        }
        return output.join('');
      }
      function traceContentPresentation(text,options){
        if(options.formatJson!==false&&/^\s*[\[{]/.test(text)){
          try{
            JSON.parse(text);
            const formatted=traceContentPrettyJson(text,options);
            return formatted===null?{json:true,text,rawOnly:true,note:'JSON 较深或格式化超过显示上限，按原文展示。'}:{json:true,text:formatted};
          }catch(_error){}
        }
        return {json:false,text};
      }
      function traceContentMessages(entry){
        if(!entry||!['model_input','model_output'].includes(entry.kind)||typeof entry.text!=='string')return null;
        let value;try{value=JSON.parse(entry.text)}catch(_error){return null}
        const read=message=>{
          if(!message||typeof message!=='object')return null;
          const tools=Array.isArray(message.tool_calls)&&message.tool_calls.length>0||message.function_call&&typeof message.function_call==='object';
          if(typeof message.content==='string')return {role:message.role,text:message.content,structured:Boolean(tools)};
          if(!Array.isArray(message.content))return null;
          const texts=message.content.filter(block=>block&&['text','input_text','output_text'].includes(block.type)&&typeof block.text==='string');
          return {role:message.role,text:texts.map(block=>block.text).join('\n\n'),structured:Boolean(tools)||texts.length!==message.content.length||texts.some(block=>Object.keys(block).some(key=>!['type','text'].includes(key)))};
        };
        if(entry.kind==='model_input'){
          const messages=Array.isArray(value)?value:value&&value.messages;
          if(!Array.isArray(messages)||!messages.length||!messages.every(message=>message&&['system','developer','user','assistant','tool'].includes(message.role)))return null;
          const result=messages.map(read);return result.every(Boolean)?result:null;
        }
        if(value&&!Array.isArray(value)&&typeof value==='object'&&Object.keys(value).some(key=>!['role','content','stopReason','stop_reason','type','id','model','usage','tool_calls','function_call','finish_reason'].includes(key)))return null;
        const blocks=Array.isArray(value)?value:value&&value.content;
        if(Array.isArray(blocks)&&blocks.some(block=>block&&['text','output_text'].includes(block.type)&&typeof block.text==='string'))return [read({role:'assistant',content:blocks,tool_calls:value&&value.tool_calls,function_call:value&&value.function_call})];
        if(value&&value.role==='assistant'&&typeof value.content==='string')return [read(value)];
        return null;
      }
      function renderTraceContentMessages(parent,messages,key,options){
        messages.forEach((message,index)=>{
          const block=make('div','trace-content-message');
          add(block,'strong','trace-content-message-role',({system:'系统',developer:'开发者',user:'用户',assistant:'助手',tool:'工具'})[message.role]||'消息');
          if(message.text.length)renderTraceContentText(block,message.text,false,key+':message:'+index,options);
          if(message.structured)add(block,'small','trace-content-note','包含工具调用、图片或其他结构化内容，可展开原文查看。');
          else if(!message.text.length)add(block,'p','trace-content-empty','消息内容为空。');
          parent.appendChild(block);
        });
      }
      function renderTraceContentText(parent,text,isJson,key,options){
        const characters=Array.from(text);
        if(characters.length<=options.previewCharacters){parent.appendChild(traceContentTextNode(text,isJson,key+':text'));return}
        const preview=make('div','trace-content-preview');
        preview.appendChild(traceContentTextNode(characters.slice(0,options.previewCharacters).join(''),isJson,key+':preview'));
        add(preview,'small','trace-content-note','部分预览 · 展开查看全部已返回内容');
        const full=traceContentDisclosure(make('details','trace-content-full-body'),key+':body');
        const summary=make('summary','trace-content-action');
        summary.setAttribute('data-trace-focus-key',key+':body');
        const update=()=>{preview.hidden=full.open;summary.textContent=full.open?'收起长内容':'查看全部已返回内容（'+characters.length+' 字）'};
        full.appendChild(summary);full.appendChild(traceContentTextNode(text,isJson,key+':text'));
        full.addEventListener('toggle',update);
        update();parent.appendChild(preview);parent.appendChild(full);
      }
      function traceContentCopyWriter(options){
        if(typeof options.copyText==='function')return options.copyText;
        try{if(typeof navigator!=='undefined'&&navigator.clipboard&&typeof navigator.clipboard.writeText==='function')return text=>navigator.clipboard.writeText(text)}catch(_error){}
        return null;
      }
      function renderTraceContentCopy(parent,entry,key,options){
        const controls=make('div','trace-content-controls');
        const button=make('button','trace-content-action','复制原文');button.type='button';
        button.setAttribute('data-trace-focus-key',key+':copy');
        button.setAttribute('aria-label','复制'+(entry.kind==='model_output'?'模型输出':traceContentKindName(entry.kind))+'原文');
        const status=make('span','trace-content-copy-status');
        status.id='trace-copy-'+encodeURIComponent(key);
        status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
        button.setAttribute('aria-describedby',status.id);
        const writer=traceContentCopyWriter(options);
        button.setAttribute('aria-disabled',String(!writer));
        let pending=false;
        if(!writer){button.disabled=true;status.textContent='当前环境不支持直接复制，可选中原文复制。'}
        else button.addEventListener('click',async()=>{
          if(pending)return;
          pending=true;button.setAttribute('aria-disabled','true');status.textContent='正在复制…';
          try{await writer(entry.text);status.textContent='原文已复制。'}
          catch(_error){status.textContent='复制失败，请选中原文手动复制。'}
          finally{pending=false;button.setAttribute('aria-disabled','false')}
        });
        controls.appendChild(button);controls.appendChild(status);parent.appendChild(controls);
      }
      function renderTraceContentSource(parent,source,key,options){
        const facts=typeof source==='string'?(source?[['采集片段',source]]:[]):source&&typeof source==='object'?[['会话引用',source.sessionRef],['运行引用',source.runRef],['轮次引用',source.turnRef],['采集片段',source.spanName],['链路片段',source.traceRef],['片段引用',source.spanRef]].filter(fact=>fact[1]):[];
        if(!facts.length)return;
        const details=traceContentDisclosure(make('details','trace-content-source-details'),key+':source');
        details.open=options.showSource===true;
        const summary=make('summary','trace-content-source-toggle','来源');summary.setAttribute('data-trace-focus-key',key+':source');details.appendChild(summary);
        const list=make('dl','trace-content-source');
        facts.forEach(fact=>{add(list,'dt','',fact[0]);add(list,'dd','',String(fact[1]))});
        if(details.open&&parent.tagName&&String(parent.tagName).toLowerCase()==='details')parent.open=true;
        details.appendChild(list);parent.appendChild(details);
      }
      function renderTraceContentEntry(parent,entry,content,source,renderOptions){
        const options=traceContentOptions(renderOptions);
        if(!entry||!traceContentKindName(entry.kind)||typeof entry.text!=='string')return null;
        const key=String(options.entryKey||'content:entry:'+entry.kind+':'+String(parent.children?parent.children.length:0));
        const card=traceContentDisclosure(make('details','trace-content-entry '+entry.kind),key);
        card.setAttribute('data-trace-entry-key',key);card.setAttribute('data-trace-content-kind',entry.kind);
        const messages=traceContentMessages(entry);
        const baseRole=traceContentRoleName(entry,source,options);
        const role=baseRole==='模型调用工具'&&messages?'模型回复 · 调用工具':baseRole;
        card.open=typeof options.initialOpen==='boolean'?options.initialOpen:(entry.kind==='tool_input'||entry.kind==='tool_output'||role==='模型调用工具'?options.toolOpen===true:true);
        const summary=make('summary','trace-content-entry-head');
        if(options.showSequence!==false&&Number(options.sequence)>0)add(summary,'span','trace-content-sequence','#'+String(options.sequence));
        add(summary,'strong','trace-content-role',role);renderTraceContentFlags(summary,content);
        card.appendChild(summary);
        const body=make('div','trace-content-entry-body');
        const footer=traceContentDisclosure(make('details','trace-content-footer'),key+':more');
        const more=make('summary','trace-content-more-toggle','原文与来源');more.setAttribute('data-trace-focus-key',key+':more');footer.appendChild(more);
        if(entry.text.length){
          const presentation=traceContentPresentation(entry.text,options);
          const formatted=make('div','trace-content-formatted');
          if(messages)renderTraceContentMessages(formatted,messages,key,options);
          else renderTraceContentText(formatted,presentation.text,presentation.json,key,options);
          if(presentation.note)add(body,'small','trace-content-note',presentation.note);
          if(messages||presentation.json&&!presentation.rawOnly){
            const raw=traceContentDisclosure(make('details','trace-content-raw'),key+':raw');
            const toggle=make('summary','trace-content-action','查看原文');toggle.setAttribute('data-trace-focus-key',key+':format');raw.appendChild(toggle);
            const original=make('div','trace-content-original');
            renderTraceContentText(original,entry.text,true,key+':raw',options);raw.appendChild(original);
            const updateMode=()=>{formatted.hidden=raw.open&&footer.open;toggle.textContent=raw.open?(messages?'返回对话视图':'返回格式化视图'):'查看原文';card.setAttribute('data-trace-body-mode',raw.open&&footer.open?'raw':'formatted')};
            raw.addEventListener('toggle',updateMode);footer.addEventListener('toggle',updateMode);
            card.setAttribute('data-trace-body-mode','formatted');footer.appendChild(raw);
          }
          body.appendChild(formatted);
        }else add(body,'p','trace-content-empty','内容为空。');
        if(content&&content.truncated)add(body,'small','trace-content-note warning','内容达到采集或返回上限；这里展示的是已返回片段，不能代表完整正文。');
        if(entry.text.length)renderTraceContentCopy(footer,entry,key,options);
        renderTraceContentSource(footer,source,key,options);
        if(footer.children.length>1)body.appendChild(footer);
        card.appendChild(body);parent.appendChild(card);return card;
      }
      function renderTraceContentItem(parent,props){
        if(!props||typeof props!=='object')return null;
        const options=Object.assign({},props.options||{});
        if(props.entryKey)options.entryKey=props.entryKey;
        if(props.sequence!=null)options.sequence=props.sequence;
        return renderTraceContentEntry(parent,props.entry,props.content||{},props.source||'',options);
      }
      function renderTraceSpanContent(parent,span,renderOptions){
        const options=traceContentOptions(renderOptions),content=traceContentState(span);
        const details=traceContentDisclosure(make('details','trace-span-content'),'content:span:'+String(span&&span.spanRef||'unknown'));
        const summary=make('summary','trace-span-content-head');
        add(summary,'span','','对话 / 工具内容');add(summary,'span','trace-content-badge',content.availability==='available'?(content.entries.length?'已采集 '+content.entries.length+' 项':'正文为空'):traceContentAvailabilityName(content.availability));
        renderTraceContentFlags(summary,content);details.appendChild(summary);
        const body=make('div','trace-span-content-body');
        if(content.availability==='available'&&content.entries.length)content.entries.forEach((entry,index)=>renderTraceContentItem(body,{entry,content,source:{spanName:span.name,spanRef:span.spanRef},entryKey:'content:span:entry:'+String(span.spanRef||'unknown')+':'+index+':'+entry.kind,sequence:index+1,options}));
        else add(body,'p','trace-content-empty',traceContentAvailabilityHint(content.availability));
        details.appendChild(body);parent.appendChild(details);return details;
      }
      function traceArchiveAvailabilityHint(value){return ({missing:'尚未发现与本 Run 精确关联的归档；历史记录缺少 Run 标识时无法认定为本轮。',expired:'本轮正文已过保留期。',unavailable:'对话归档暂不可用，可刷新详情重试。',unbound:'运行未携带会话标识，无法查询对话上下文。',conflict:'运行与对话标识发生冲突，已停止展示关联正文。'})[String(value||'')]||'该轮没有已采集正文。'}
      function renderTraceArchivedTurn(parent,turn,context,label,key,primaryOnly){
        const block=make('section','trace-archive-turn');if(label){add(block,'h4','',label);add(block,'small','trace-content-note',when(turn&&turn.recordedAt))}
        const content=traceContentState({content:turn&&turn.content});
        if(content.availability==='available'){
          const entries=content.entries.map((entry,index)=>({entry,index})).filter(item=>!primaryOnly||traceConversationPrimaryEntry(item.entry));
          if(!entries.length)add(block,'p','trace-content-empty',primaryOnly?'本轮归档未返回用户或助手正文。':'该轮没有已采集正文。');
          entries.forEach(item=>renderTraceContentItem(block,{entry:item.entry,content,source:{sessionRef:context.sessionRef,runRef:turn.runRef,turnRef:turn.turnRef},entryKey:key+':'+String(turn.turnRef||'unknown')+':'+item.index,options:{showSequence:false}}));
        }else add(block,'p','trace-content-empty',traceContentAvailabilityHint(content.availability));
        parent.appendChild(block);
      }
      function renderTraceBoundConversation(parent,detail){
        const context=detail&&detail.conversationContext;
        const panel=traceContentDisclosure(make('details','trace-conversation trace-bound-context'),'context:conversation');panel.open=true;
        const primary=traceConversationPrimaryEntries(detail);
        const head=make('summary','trace-conversation-head');head.setAttribute('data-trace-focus-key','context:conversation');add(head,'strong','','本轮对话');add(head,'span','',primary.length?(context&&context.currentTurn&&context.currentTurn.availability==='available'?'精确归档':'本次采集'):({bound:'已绑定会话',unbound:'未绑定会话',conflict:'绑定冲突'})[context&&context.binding]||'绑定信息未返回');panel.appendChild(head);
        const body=make('div','trace-conversation-body');
        const sessionRef=context&&context.sessionRef||detail&&detail.run&&detail.run.sessionRef;
        if(!context||context.binding!=='bound'||context.runRef&&detail.run&&context.runRef!==detail.run.runRef)add(body,'p','trace-content-empty',traceArchiveAvailabilityHint(context&&context.runRef&&detail.run&&context.runRef!==detail.run.runRef?'conflict':context&&context.binding||'unavailable'));
        else{
          const current=context.currentTurn||{availability:'unavailable'};
          if(current.availability==='available'&&current.turn)renderTraceArchivedTurn(body,current.turn,context,'','context:current',true);
          else{
            const captured=traceConversationCapturedEntries(detail);
            if(captured.length){
              const block=make('section','trace-archive-turn trace-captured-turn');
              captured.forEach((item,index)=>renderTraceContentItem(block,{entry:item.entry,content:item.content,source:{sessionRef:context.sessionRef,runRef:context.runRef,spanName:item.span.name,spanRef:item.span.spanRef,traceRef:item.group.traceRef},entryKey:'context:captured:'+String(item.group.traceRef||item.groupIndex)+':'+String(item.span.spanRef||item.spanIndex)+':'+item.entryIndex+':'+item.entry.kind,sequence:index+1,options:{showSequence:false}}));
              body.appendChild(block);
              add(body,'p','trace-content-note',traceArchiveAvailabilityHint(current.availability));
            }else add(body,'p','trace-content-empty',traceArchiveAvailabilityHint(current.availability));
          }
          const history=context.history||{availability:'unavailable'},turns=history.availability==='available'?traceList(history.turns):[];
          const previous=traceContentDisclosure(make('details','trace-context-history'),'context:history');const summary=make('summary','trace-content-action','会话与归档'+(turns.length?' · 此前 '+turns.length+' 轮':history.availability==='unavailable'?' · 历史暂不可用':history.availability==='expired'?' · 历史已过期':history.availability==='conflict'?' · 历史绑定冲突':''));summary.setAttribute('data-trace-focus-key','context:history');previous.appendChild(summary);
          add(previous,'p','trace-content-note','会话：'+String(sessionRef||'未关联')+' · 运行：'+String(context&&context.runRef||detail&&detail.run&&detail.run.runRef||'—'));
          if(current.turn&&current.turn.recordedAt)add(previous,'p','trace-content-note','本轮归档：'+when(current.turn.recordedAt));
          add(previous,'p','trace-content-note','此前记录来自同一会话的归档；模型实际使用的上下文以本次模型输入快照为准。');
          if(turns.length)turns.forEach(turn=>renderTraceArchivedTurn(previous,turn,context,'此前对话','context:history'));
          else add(previous,'p','trace-content-empty',history.availability==='missing'?'没有已归档的此前会话记录。':traceArchiveAvailabilityHint(history.availability));
          if(history.truncated)add(previous,'small','trace-content-note','仅返回最近 8 轮此前记录。');
          body.appendChild(previous);
        }
        panel.appendChild(body);parent.appendChild(panel);return panel;
      }
      function traceConversationItems(detail){
        const items=[];
        traceList(detail&&detail.traces).forEach((group,groupIndex)=>{
          const groupStart=Date.parse(group&&group.startedAt||'');
          traceList(group&&group.spans).forEach((span,spanIndex)=>{
            const content=traceContentState(span);if(content.availability!=='available')return;
            const spanStart=Date.parse(span&&span.startedAt||'');
            const start=Number.isFinite(spanStart)?spanStart:(Number.isFinite(groupStart)?groupStart:0)+(Number(span&&span.startOffsetMs)||0);
            content.entries.forEach((entry,entryIndex)=>items.push({entry,content,span,group,groupIndex,spanIndex,entryIndex,time:start+((entry.kind==='model_output'||entry.kind==='tool_output')?Math.max(0,Number(span&&span.durationMs)||0):0)}));
          });
        });
        return items.sort((a,b)=>a.time-b.time||a.groupIndex-b.groupIndex||a.spanIndex-b.spanIndex||a.entryIndex-b.entryIndex);
      }
      function traceConversationPrimaryEntry(entry){return entry&&entry.kind==='user_input'||entry&&entry.kind==='model_output'&&(traceContentRoleName(entry,null,{})!=='模型调用工具'||traceContentMessages(entry))}
      function traceConversationCapturedEntries(detail){
        const context=detail&&detail.conversationContext,current=context&&context.currentTurn;
        if(!context||context.binding!=='bound'||!current||!['missing','unavailable'].includes(current.availability)||context.runRef&&detail.run&&context.runRef!==detail.run.runRef)return [];
        return traceConversationItems(detail).filter(item=>traceConversationPrimaryEntry(item.entry));
      }
      function traceConversationPrimaryEntries(detail){
        const context=detail&&detail.conversationContext,current=context&&context.currentTurn;
        if(!context||context.binding!=='bound'||!current||context.runRef&&detail.run&&context.runRef!==detail.run.runRef)return [];
        if(current.availability==='available'&&current.turn){const content=traceContentState({content:current.turn.content});return content.availability==='available'?content.entries.filter(traceConversationPrimaryEntry):[]}
        return traceConversationCapturedEntries(detail).map(item=>item.entry);
      }
      function traceConversationEntrySignature(entry){
        const messages=traceContentMessages(entry);
        return entry.kind+'\u0000'+(messages?messages.map(message=>message.text).join('\n\n'):entry.text);
      }
      function traceConversationEvidenceItems(detail){
        const items=traceConversationItems(detail),context=detail&&detail.conversationContext,current=context&&context.currentTurn;
        if(!context||context.binding!=='bound'||!current||current.availability!=='available'||!current.turn||context.runRef&&detail.run&&context.runRef!==detail.run.runRef)return items;
        const content=traceContentState({content:current.turn.content});if(content.availability!=='available')return items;
        const signatures=new Set(items.map(item=>item.entry.kind+'\u0000'+item.entry.text));
        content.entries.forEach((entry,entryIndex)=>{
          if(traceConversationPrimaryEntry(entry)||signatures.has(entry.kind+'\u0000'+entry.text))return;
          items.push({entry,content,span:{name:'本轮归档'},group:{},entryIndex,
            entryKey:'content:conversation:archive:'+String(current.turn.turnRef||'unknown')+':'+entryIndex+':'+entry.kind,
            source:{sessionRef:context.sessionRef,runRef:current.turn.runRef||context.runRef,turnRef:current.turn.turnRef}});
        });
        return items;
      }
      function renderTraceConversation(parent,detail,renderOptions){
        const options=traceContentOptions(renderOptions);
        const primary=traceConversationPrimaryEntries(detail),hasPrimary=primary.length>0;
        const signatures=new Set(primary.map(traceConversationEntrySignature)),rawSignatures=new Set(primary.map(entry=>entry.kind+'\u0000'+entry.text));
        const entries=traceConversationEvidenceItems(detail).filter(item=>{
          if(!hasPrimary||!traceConversationPrimaryEntry(item.entry))return true;
          const messages=traceContentMessages(item.entry),structured=messages&&messages.some(message=>message.structured);
          return !rawSignatures.has(item.entry.kind+'\u0000'+item.entry.text)&&(structured||!signatures.has(traceConversationEntrySignature(item.entry)));
        });
        const panel=traceContentDisclosure(make('details','trace-conversation'),'content:conversation');
        panel.open=options.loading||options.error?true:hasPrimary?Boolean(renderOptions&&renderOptions.conversationOpen===true):options.conversationOpen!==false;
        const summary=make('summary','trace-conversation-head');summary.setAttribute('data-trace-focus-key','content:conversation');
        add(summary,'strong','',options.title||(hasPrimary?'模型与工具证据':'本次调用的对话与工具内容'));
        const inputs=entries.filter(item=>item.entry.kind==='model_input');
        const states={not_captured:0,expired:0,unavailable:0,available:0};
        traceList(detail&&detail.traces).forEach(group=>traceList(group&&group.spans).forEach(span=>{states[traceContentState(span).availability]+=1}));
        const unavailable=states.unavailable?' · 部分正文暂不可用':states.expired?' · 部分正文已过期':'';
        const emptyEvidence=states.unavailable?'模型与工具正文暂不可用':states.expired?'模型与工具正文已过保留期':states.not_captured?'模型与工具正文未采集':'没有额外模型或工具正文';
        add(summary,'span','',options.loading?'正在读取正文':options.error?'正文读取失败':entries.length?'已采集 '+entries.length+' 项'+(hasPrimary&&!inputs.length?' · 模型上下文未采集':'')+unavailable:hasPrimary?emptyEvidence:'没有可展示的正文');
        if(entries.some(item=>item.content.truncated))add(summary,'span','trace-content-badge warning','已截断');
        panel.appendChild(summary);
        const body=make('div','trace-conversation-body');
        if(options.loading){panel.setAttribute('aria-busy','true');const status=add(body,'p','trace-content-empty','正在读取对话与工具内容…');status.setAttribute('role','status')}
        else if(options.error){const error=add(body,'p','trace-content-empty warning','正文读取失败：'+String(options.error));error.setAttribute('role','alert')}
        else if(entries.length){
          add(body,'p','trace-content-note',inputs.length?'已采集模型实际输入快照'+(inputs.some(item=>item.content.truncated)?'；快照已截断，不能代表完整输入。':'。'):'模型实际上下文未采集；当前正文不能还原本次完整模型输入。');
          entries.forEach((item,index)=>renderTraceContentItem(body,{entry:item.entry,content:item.content,source:item.source||{spanName:item.span.name,spanRef:item.span.spanRef,traceRef:item.group.traceRef},entryKey:item.entryKey||'content:conversation:entry:'+String(item.group.traceRef||item.groupIndex)+':'+String(item.span.spanRef||item.spanIndex)+':'+item.entryIndex+':'+item.entry.kind,sequence:index+1,options}));
        }else if(hasPrimary){
          add(body,'p','trace-content-empty','本轮用户与助手正文已在上方展示；当前没有额外模型输入或工具正文。');
          if(states.unavailable)add(body,'p','trace-content-empty',traceContentAvailabilityHint('unavailable'));
          if(states.expired)add(body,'p','trace-content-empty',traceContentAvailabilityHint('expired'));
        }
        else{
          const counts={not_captured:0,expired:0,unavailable:0,available:0};
          traceList(detail&&detail.traces).forEach(group=>traceList(group&&group.spans).forEach(span=>{counts[traceContentState(span).availability]+=1}));
          const states=Object.entries(counts).filter(entry=>entry[1]>0);
          if(!states.length)add(body,'p','trace-content-empty','该运行没有已采集正文；历史内容无法从运行摘要或链路指标补回。');
          else states.forEach(entry=>add(body,'p','trace-content-empty',traceContentAvailabilityHint(entry[0])+'（'+entry[1]+' 个片段）'));
        }
        panel.appendChild(body);parent.appendChild(panel);return panel;
      }
`;
