/* ========================================================================
   CHRONOFORGE — app logic
   Vanilla JS, localStorage-backed, pointer-events drag & drop (touch-first).
   ======================================================================== */
(function(){
"use strict";

/* ============================= CONSTANTS ============================= */
const STORAGE_KEY = "chronoforge_state_v1";
const ROW_HEIGHT = 64;           // px per hour — must match .hour-row height in style.css
const SNAP_MIN = 15;             // drag/resize snapping, minutes
const MIN_DURATION = 15;         // minutes

const FOLDER_PALETTE = [
  { name:"Steel Blue", hex:"#37d6ff" },
  { name:"Bronze",     hex:"#c17b3e" },
  { name:"Copper",     hex:"#e8935a" },
  { name:"Graphite",   hex:"#9aa0a5" },
  { name:"Amber",      hex:"#ffb238" },
  { name:"Verdigris",  hex:"#4be0a7" },
];

/* ============================= STATE ============================= */
let state = null;      // persisted
let runtime = {         // not persisted
  gcalToken: null,
  gcalConnected: false,
  gcalExpiry: 0,
  drag: null,           // active drag/resize session
};

function defaultState(){
  const today = ymd(new Date());
  return {
    version: 1,
    folders: [
      { id:"personal", name:"Personal", hex:"#37d6ff" },
      { id:"school",   name:"School",   hex:"#c17b3e" },
      { id:"general",  name:"General",  hex:"#9aa0a5" },
    ],
    projects: [],
    scheduleBlocks: [],
    trayItems: [],
    settings: {
      dayStartHour: 6,
      dayEndHour: 23,
      gcalClientId: "",
      activeFolder: "all",
    },
    viewDate: today,
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // shallow-merge with defaults so new fields survive upgrades
    const base = defaultState();
    return Object.assign(base, parsed, {
      settings: Object.assign(base.settings, parsed.settings||{}),
    });
  }catch(e){
    console.error("Failed to load state, starting fresh.", e);
    return defaultState();
  }
}

function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){
    console.error("Failed to save state", e);
  }
}

/* ============================= UTILITIES ============================= */
function uid(prefix){ return (prefix||"id") + "_" + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }
function round2(n){ return Math.round(n*100)/100; }
function clamp(n,min,max){ return Math.max(min, Math.min(max,n)); }
function ymd(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function parseYmd(s){ const [y,m,d]=s.split("-").map(Number); return new Date(y, m-1, d); }
function addDays(dateStr, n){ const d=parseYmd(dateStr); d.setDate(d.getDate()+n); return ymd(d); }
function startOfWeek(dateStr){ // Monday-start
  const d = parseYmd(dateStr);
  const dow = (d.getDay()+6)%7; // 0=Mon
  d.setDate(d.getDate()-dow);
  return ymd(d);
}
function daysBetween(fromStr, toStr){
  const a = parseYmd(fromStr), b = parseYmd(toStr);
  return Math.round((b-a)/86400000);
}
function todayStr(){ return ymd(new Date()); }
function formatMin(totalMin){
  totalMin = ((totalMin%1440)+1440)%1440;
  let h = Math.floor(totalMin/60), m = totalMin%60;
  const ampm = h>=12 ? "PM":"AM";
  h = h%12; if(h===0) h=12;
  return `${h}:${String(m).padStart(2,"0")} ${ampm}`;
}
function formatDuration(min){
  const h = Math.floor(min/60), m = min%60;
  if(h && m) return `${h}h ${m}m`;
  if(h) return `${h}h`;
  return `${m}m`;
}
function formatDateHuman(dateStr){
  const d = parseYmd(dateStr);
  return d.toLocaleDateString(undefined, { weekday:"long", month:"long", day:"numeric" });
}
function escapeHtml(s){
  return String(s==null?"":s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
function folderById(id){ return state.folders.find(f=>f.id===id); }
function folderColor(id){ const f=folderById(id); return f ? f.hex : "#9aa0a5"; }
function projectById(id){ return state.projects.find(p=>p.id===id); }
function findStep(stepId){
  for(const p of state.projects){
    const s = p.steps.find(s=>s.id===stepId);
    if(s) return { step:s, project:p };
  }
  return null;
}

/* ============================= URGENCY / PRIORITY ============================= */
// returns { level: 'overdue'|'high'|'medium'|'low', hoursPerDay, daysLeft, remaining }
function computeUrgency(remainingHours, deadlineStr){
  if(remainingHours<=0) return { level:"low", hoursPerDay:0, daysLeft:null, remaining:0 };
  if(!deadlineStr) return { level:"low", hoursPerDay:0, daysLeft:null, remaining:remainingHours };
  const daysLeft = daysBetween(todayStr(), deadlineStr);
  if(daysLeft < 0) return { level:"overdue", hoursPerDay:Infinity, daysLeft, remaining:remainingHours };
  const effectiveDays = Math.max(daysLeft, 0.2);
  const hoursPerDay = remainingHours/effectiveDays;
  let level = "low";
  if(daysLeft===0 && remainingHours>0) level="overdue";
  else if(hoursPerDay>3) level="high";
  else if(hoursPerDay>1) level="medium";
  return { level, hoursPerDay, daysLeft, remaining:remainingHours };
}
function stepRemaining(step){ return Math.max(0, round2(step.estHours - step.loggedHours)); }
function stepUrgency(step, project){
  if(step.done) return { level:"low", hoursPerDay:0, daysLeft:null, remaining:0 };
  const deadline = step.deadline || project.deadline;
  return computeUrgency(stepRemaining(step), deadline);
}
function projectUrgency(project){
  let worst = { level:"low", hoursPerDay:0, daysLeft:null, remaining:0 };
  const order = { overdue:3, high:2, medium:1, low:0 };
  let any=false;
  for(const step of project.steps){
    if(step.done) continue;
    any=true;
    const u = stepUrgency(step, project);
    if(order[u.level] > order[worst.level]) worst = u;
  }
  if(!any && project.deadline){
    return computeUrgency(0, project.deadline);
  }
  return worst;
}
function levelLabel(level){
  return { overdue:"Overdue", high:"Urgent", medium:"On Track", low:"Low Priority" }[level] || "Low Priority";
}

/* ============================= RECONCILE (auto time-logging) ============================= */
function reconcile(){
  const now = new Date();
  const nowStr = ymd(now);
  const nowMin = now.getHours()*60 + now.getMinutes();
  let changed = false;
  state.scheduleBlocks.forEach(b=>{
    if(b.logged || !b.stepId) return;
    const past = (b.date < nowStr) || (b.date === nowStr && (b.startMin + b.durationMin) <= nowMin);
    if(past){
      const found = findStep(b.stepId);
      if(found){
        found.step.loggedHours = round2(found.step.loggedHours + b.durationMin/60);
      }
      b.logged = true;
      changed = true;
    }
  });
  if(changed){ saveState(); renderPlanner(); renderProjects(); }
}

/* ============================= RENDER: SHELL ============================= */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function renderClock(){
  const el = $("#live-clock");
  if(el) el.textContent = new Date().toLocaleTimeString(undefined,{ hour:"2-digit", minute:"2-digit" });
}

function switchView(view){
  $$(".view").forEach(v=>v.classList.remove("active"));
  $(`#view-${view}`).classList.add("active");
  $$(".tab-btn").forEach(b=>b.classList.toggle("active", b.dataset.view===view));
  if(view==="planner") renderPlanner();
  if(view==="projects") renderProjects();
}

/* ============================= RENDER: PLANNER ============================= */
function renderWeekStrip(){
  const wrap = $("#week-strip");
  wrap.innerHTML = "";
  const weekStart = startOfWeek(state.viewDate);
  const names = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  for(let i=0;i<7;i++){
    const d = addDays(weekStart, i);
    const dd = parseYmd(d);
    const chip = document.createElement("button");
    chip.className = "day-chip" + (d===state.viewDate?" active":"") + (d===todayStr()?" is-today":"");
    chip.innerHTML = `<span class="dc-name">${names[i]}</span><span class="dc-num">${dd.getDate()}</span>`;
    chip.addEventListener("click", ()=>{ state.viewDate = d; saveState(); renderPlanner(); });
    wrap.appendChild(chip);
  }
}

function renderDayTitle(){
  $("#day-title-main").textContent = state.viewDate===todayStr() ? "Today" :
    (state.viewDate===addDays(todayStr(),1) ? "Tomorrow" :
    (state.viewDate===addDays(todayStr(),-1) ? "Yesterday" : formatDateHuman(state.viewDate).split(",")[0]));
  $("#day-title-date").textContent = formatDateHuman(state.viewDate);
}

function renderTimeline(){
  const timeline = $("#timeline");
  const { dayStartHour, dayEndHour } = state.settings;
  timeline.innerHTML = "";
  timeline.style.height = ((dayEndHour-dayStartHour)*ROW_HEIGHT + 20) + "px";

  for(let h=dayStartHour; h<dayEndHour; h++){
    const row = document.createElement("div");
    row.className = "hour-row";
    row.innerHTML = `<span class="hour-label">${formatMin(h*60)}</span><span class="half-line"></span>`;
    timeline.appendChild(row);
  }

  // now-line (only if viewing today)
  if(state.viewDate === todayStr()){
    const now = new Date();
    const nowMin = now.getHours()*60+now.getMinutes();
    if(nowMin >= dayStartHour*60 && nowMin <= dayEndHour*60){
      const line = document.createElement("div");
      line.className = "now-line";
      line.style.top = ((nowMin-dayStartHour*60)/60*ROW_HEIGHT) + "px";
      timeline.appendChild(line);
    }
  }

  // schedule blocks for this date
  const blocks = state.scheduleBlocks.filter(b=>b.date===state.viewDate).sort((a,b)=>a.startMin-b.startMin);
  blocks.forEach(b=>renderBlock(timeline, b));
}

function renderBlock(timeline, b){
  const { dayStartHour } = state.settings;
  const el = document.createElement("div");
  el.className = "sched-block" + (b.logged?" is-logged":"") + (b.source==="gcal"?" is-gcal":"");
  el.dataset.id = b.id;
  const top = (b.startMin - dayStartHour*60)/60*ROW_HEIGHT;
  const height = Math.max(20, b.durationMin/60*ROW_HEIGHT - 2);
  el.style.top = top+"px";
  el.style.height = height+"px";
  const linkedColor = b.projectId ? folderColor(projectById(b.projectId)?.folderId) : null;
  if(linkedColor) el.style.borderLeftColor = linkedColor;

  const proj = b.projectId ? projectById(b.projectId) : null;
  const stepInfo = b.stepId ? findStep(b.stepId) : null;
  const subtitle = proj ? escapeHtml(proj.name) + (stepInfo? " · "+escapeHtml(stepInfo.step.name):"") : (b.source==="gcal" ? "Google Calendar" : "");

  el.innerHTML = `
    <div class="sb-actions">
      <button class="sb-mini-btn sb-del" title="Delete"><svg viewBox="0 0 24 24"><use href="#icon-close"></use></svg></button>
    </div>
    <span class="sb-title">${escapeHtml(b.title)}</span>
    <span class="sb-time">${formatMin(b.startMin)} – ${formatMin(b.startMin+b.durationMin)}${subtitle?" · "+subtitle:""}</span>
    ${height>34 && !b.logged ? '<div class="sched-resize"></div>' : ""}
  `;

  el.querySelector(".sb-del").addEventListener("click", (e)=>{ e.stopPropagation(); deleteBlock(b.id); });

  const resizeHandle = el.querySelector(".sched-resize");
  if(resizeHandle){
    resizeHandle.addEventListener("pointerdown", (e)=>startResize(e, b.id));
  }
  if(!b.logged){
    el.addEventListener("pointerdown", (e)=>{
      if(e.target.closest(".sched-resize") || e.target.closest(".sb-mini-btn")) return;
      startMoveBlock(e, b.id);
    });
  }
  timeline.appendChild(el);
}

function renderPriorityList(){
  const wrap = $("#priority-list");
  const items = [];
  state.projects.forEach(p=>{
    p.steps.forEach(s=>{
      if(s.done) return;
      const u = stepUrgency(s, p);
      if(u.level==="low" && u.remaining<=0) return;
      items.push({ step:s, project:p, urgency:u });
    });
  });
  const order = { overdue:3, high:2, medium:1, low:0 };
  items.sort((a,b)=> order[b.urgency.level]-order[a.urgency.level] || (a.urgency.daysLeft??999)-(b.urgency.daysLeft??999));

  if(!items.length){
    wrap.innerHTML = `<div class="priority-empty">Nothing urgent — add project steps with deadlines to see them here.</div>`;
    return;
  }
  wrap.innerHTML = "";
  items.slice(0,8).forEach(it=>{
    const row = document.createElement("div");
    row.className = "priority-item";
    const meta = it.urgency.daysLeft==null ? `${it.urgency.remaining}h remaining` :
      it.urgency.level==="overdue" ? `Overdue · ${it.urgency.remaining}h left` :
      `${it.urgency.remaining}h left · ${it.urgency.daysLeft}d to go`;
    row.innerHTML = `
      <span class="led-dot led-${it.urgency.level}" title="${levelLabel(it.urgency.level)}"></span>
      <span class="pi-text">
        <span class="pi-name">${escapeHtml(it.project.name)} · ${escapeHtml(it.step.name)}</span>
        <span class="pi-meta">${meta}</span>
      </span>
      <button class="mini-add-btn" title="Add to tray">+</button>
    `;
    row.querySelector(".mini-add-btn").addEventListener("click", ()=> pushStepToTray(it.step.id));
    wrap.appendChild(row);
  });
}

function renderTray(){
  const wrap = $("#tray-list");
  if(!state.trayItems.length){
    wrap.innerHTML = `<div class="tray-empty">Tray is empty. Add an item above, or pull in a project step from Top Priority.</div>`;
    return;
  }
  wrap.innerHTML = "";
  state.trayItems.forEach(item=>{
    const proj = item.projectId ? projectById(item.projectId) : null;
    const card = document.createElement("div");
    card.className = "tray-card";
    card.dataset.id = item.id;
    if(proj) card.style.borderLeftColor = folderColor(proj.folderId);
    card.innerHTML = `
      <svg class="drag-handle" viewBox="0 0 24 24"><use href="#icon-grip"></use></svg>
      <span class="tc-text">
        <span class="tc-name">${escapeHtml(item.title)}</span>
        <span class="tc-meta">${formatDuration(item.durationMin)}${proj?" · "+escapeHtml(proj.name):""}</span>
      </span>
      <button class="tc-del" title="Remove"><svg viewBox="0 0 24 24"><use href="#icon-trash"></use></svg></button>
    `;
    card.querySelector(".tc-del").addEventListener("click", ()=>{
      state.trayItems = state.trayItems.filter(t=>t.id!==item.id);
      saveState(); renderTray();
    });
    card.querySelector(".drag-handle").addEventListener("pointerdown", (e)=>startDragFromTray(e, item.id));
    wrap.appendChild(card);
  });
}

function populateProjectSelect(){
  const sel = $("#qa-project");
  const current = sel.value;
  sel.innerHTML = `<option value="">No project</option>` + state.projects.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  sel.value = current;
}

function renderPlanner(){
  renderClock();
  renderWeekStrip();
  renderDayTitle();
  renderTimeline();
  renderPriorityList();
  renderTray();
  populateProjectSelect();
}

/* ============================= DRAG & DROP (pointer events) ============================= */
const ghost = () => $("#drag-ghost");

function timelineScrollRect(){ return $("#timeline-scroll").getBoundingClientRect(); }
function timelineRect(){ return $("#timeline").getBoundingClientRect(); }

function yToSnappedMinutes(clientY){
  const rect = timelineRect();
  const { dayStartHour, dayEndHour } = state.settings;
  const y = clientY - rect.top;
  let min = dayStartHour*60 + (y/ROW_HEIGHT)*60;
  min = Math.round(min/SNAP_MIN)*SNAP_MIN;
  return clamp(min, dayStartHour*60, dayEndHour*60 - MIN_DURATION);
}

function isOverTimeline(clientX, clientY){
  const r = timelineScrollRect();
  return clientX>=r.left && clientX<=r.right && clientY>=r.top && clientY<=r.bottom;
}

function autoScrollDuringDrag(clientY){
  const scrollEl = $("#timeline-scroll");
  const r = scrollEl.getBoundingClientRect();
  const edge = 50;
  if(clientY < r.top+edge) scrollEl.scrollTop -= 12;
  else if(clientY > r.bottom-edge) scrollEl.scrollTop += 12;
}

function showDropHighlight(min){
  let hl = $("#drop-highlight-el");
  const timeline = $("#timeline");
  if(!hl){
    hl = document.createElement("div");
    hl.id = "drop-highlight-el";
    hl.className = "drop-highlight";
    timeline.appendChild(hl);
  }
  const { dayStartHour } = state.settings;
  hl.style.top = ((min-dayStartHour*60)/60*ROW_HEIGHT) + "px";
  hl.style.display = "block";
}
function hideDropHighlight(){ const hl = $("#drop-highlight-el"); if(hl) hl.style.display="none"; }

function startDragFromTray(e, itemId){
  e.preventDefault();
  const item = state.trayItems.find(t=>t.id===itemId);
  if(!item) return;
  runtime.drag = { type:"new", itemId, durationMin:item.durationMin, title:item.title };
  beginGhost(e, item.title + " · " + formatDuration(item.durationMin));
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
}

function startMoveBlock(e, blockId){
  e.preventDefault();
  const b = state.scheduleBlocks.find(x=>x.id===blockId);
  if(!b) return;
  runtime.drag = { type:"move", blockId, durationMin:b.durationMin, title:b.title, origStartMin:b.startMin };
  beginGhost(e, b.title);
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
}

function startResize(e, blockId){
  e.preventDefault();
  e.stopPropagation();
  const b = state.scheduleBlocks.find(x=>x.id===blockId);
  if(!b) return;
  runtime.drag = { type:"resize", blockId, startClientY:e.clientY, origDuration:b.durationMin };
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", onResizeEnd);
}

function beginGhost(e, label){
  const g = ghost();
  g.textContent = label;
  g.style.left = e.clientX+"px";
  g.style.top = e.clientY+"px";
  g.classList.remove("hidden");
}

function onDragMove(e){
  if(!runtime.drag) return;
  const g = ghost();
  g.style.left = e.clientX+"px";
  g.style.top = e.clientY+"px";
  if(isOverTimeline(e.clientX, e.clientY)){
    autoScrollDuringDrag(e.clientY);
    const min = yToSnappedMinutes(e.clientY);
    showDropHighlight(min);
    g.textContent = `${runtime.drag.title} · ${formatMin(min)}`;
  } else {
    hideDropHighlight();
  }
}

function onDragEnd(e){
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  ghost().classList.add("hidden");
  hideDropHighlight();
  const drag = runtime.drag;
  runtime.drag = null;
  if(!drag) return;

  if(isOverTimeline(e.clientX, e.clientY)){
    const min = yToSnappedMinutes(e.clientY);
    if(drag.type==="new"){
      const item = state.trayItems.find(t=>t.id===drag.itemId);
      if(!item) return;
      state.scheduleBlocks.push({
        id: uid("blk"), title:item.title, date:state.viewDate,
        startMin:min, durationMin:item.durationMin,
        projectId:item.projectId||null, stepId:item.stepId||null,
        logged:false, source:"manual",
      });
      state.trayItems = state.trayItems.filter(t=>t.id!==item.id);
    } else if(drag.type==="move"){
      const b = state.scheduleBlocks.find(x=>x.id===drag.blockId);
      if(b) b.startMin = clamp(min, state.settings.dayStartHour*60, state.settings.dayEndHour*60 - b.durationMin);
    }
    saveState();
    renderPlanner();
  }
}

function onResizeMove(e){
  if(!runtime.drag) return;
  const b = state.scheduleBlocks.find(x=>x.id===runtime.drag.blockId);
  if(!b) return;
  const deltaPx = e.clientY - runtime.drag.startClientY;
  const deltaMin = Math.round((deltaPx/ROW_HEIGHT*60)/SNAP_MIN)*SNAP_MIN;
  const newDuration = Math.max(MIN_DURATION, runtime.drag.origDuration + deltaMin);
  const el = document.querySelector(`.sched-block[data-id="${b.id}"]`);
  if(el) el.style.height = Math.max(20, newDuration/60*ROW_HEIGHT - 2) + "px";
  runtime._pendingDuration = newDuration;
}

function onResizeEnd(){
  window.removeEventListener("pointermove", onResizeMove);
  window.removeEventListener("pointerup", onResizeEnd);
  if(runtime.drag && runtime._pendingDuration){
    const b = state.scheduleBlocks.find(x=>x.id===runtime.drag.blockId);
    if(b) b.durationMin = runtime._pendingDuration;
    saveState();
  }
  runtime._pendingDuration = null;
  runtime.drag = null;
  renderPlanner();
}

function deleteBlock(blockId){
  state.scheduleBlocks = state.scheduleBlocks.filter(b=>b.id!==blockId);
  saveState();
  renderPlanner();
}

/* ============================= TRAY / QUICK ADD ============================= */
function pushStepToTray(stepId){
  const found = findStep(stepId);
  if(!found) return;
  const { step, project } = found;
  const existing = state.trayItems.find(t=>t.stepId===stepId);
  if(existing) { switchView("planner"); return; }
  const remaining = stepRemaining(step) || 0.5;
  const durationMin = clamp(Math.round(remaining*60/15)*15, 15, 240);
  state.trayItems.push({
    id: uid("tray"), title: `${project.name} — ${step.name}`,
    durationMin, projectId:project.id, stepId:step.id,
  });
  saveState();
  switchView("planner");
}

function wireQuickAdd(){
  const toggleBtn = $("#quick-add-toggle");
  const form = $("#quick-add-form");
  toggleBtn.addEventListener("click", ()=> form.classList.toggle("hidden"));
  $("#qa-cancel").addEventListener("click", ()=> form.classList.add("hidden"));
  form.addEventListener("submit", (e)=>{
    e.preventDefault();
    const title = $("#qa-title").value.trim();
    const duration = Math.max(5, parseInt($("#qa-duration").value,10)||30);
    const projectId = $("#qa-project").value || null;
    if(!title) return;
    state.trayItems.push({ id:uid("tray"), title, durationMin:duration, projectId, stepId:null });
    saveState();
    form.reset(); $("#qa-duration").value = 30;
    form.classList.add("hidden");
    renderTray();
  });
}

/* ============================= RENDER: PROJECTS ============================= */
function renderFolderTabs(){
  const wrap = $("#folder-tabs");
  wrap.innerHTML = "";
  const allTab = document.createElement("button");
  allTab.className = "folder-tab" + (state.settings.activeFolder==="all"?" active":"");
  allTab.innerHTML = `<span class="swatch" style="background:#9aa0a5"></span> All Projects`;
  allTab.addEventListener("click", ()=>{ state.settings.activeFolder="all"; saveState(); renderProjects(); });
  wrap.appendChild(allTab);

  state.folders.forEach(f=>{
    const tab = document.createElement("button");
    tab.className = "folder-tab" + (state.settings.activeFolder===f.id?" active":"");
    tab.innerHTML = `<span class="swatch" style="background:${f.hex}"></span> ${escapeHtml(f.name)}`;
    tab.addEventListener("click", ()=>{ state.settings.activeFolder=f.id; saveState(); renderProjects(); });
    wrap.appendChild(tab);
  });
}

function renderProjects(){
  renderFolderTabs();
  const grid = $("#projects-grid");
  let projects = state.projects;
  if(state.settings.activeFolder!=="all") projects = projects.filter(p=>p.folderId===state.settings.activeFolder);

  if(!projects.length){
    grid.innerHTML = `<div class="empty-state">No projects yet. Click "+ New Project" to forge one.</div>`;
    return;
  }

  // sort: most urgent first
  const order = { overdue:3, high:2, medium:1, low:0 };
  projects = [...projects].sort((a,b)=> order[projectUrgency(b).level]-order[projectUrgency(a).level]);

  grid.innerHTML = "";
  projects.forEach(p=> grid.appendChild(renderProjectCard(p)));
}

function renderProjectCard(p){
  const card = document.createElement("div");
  card.className = "project-card";
  card.style.setProperty("--folder-color", folderColor(p.folderId));

  const totalEst = p.steps.reduce((s,st)=>s+st.estHours,0);
  const totalLogged = p.steps.reduce((s,st)=>s+st.loggedHours,0);
  const pct = totalEst>0 ? clamp(Math.round(totalLogged/totalEst*100),0,100) : (p.steps.length && p.steps.every(s=>s.done) ? 100 : 0);
  const urgency = projectUrgency(p);
  const folder = folderById(p.folderId);
  const overdue = p.deadline && daysBetween(todayStr(), p.deadline) < 0;

  card.innerHTML = `
    <div class="pc-head">
      <div>
        <div class="pc-name">${escapeHtml(p.name)}</div>
        <div class="pc-folder">${escapeHtml(folder?folder.name:"—")}</div>
      </div>
      <div class="pc-menu">
        <button class="sb-mini-btn pc-del" title="Delete project"><svg viewBox="0 0 24 24"><use href="#icon-trash"></use></svg></button>
      </div>
    </div>
    ${p.deadline ? `<div class="pc-deadline ${overdue?"overdue":""}"><svg viewBox="0 0 24 24"><use href="#icon-calendar"></use></svg> Due ${formatDateHuman(p.deadline)}${overdue?" · OVERDUE":""}</div>` : ""}
    <div class="pc-progress-wrap">
      <div class="pc-progress-bar"><div class="pc-progress-fill" style="width:${pct}%"></div></div>
      <div class="pc-progress-label">${round2(totalLogged)}h logged of ${round2(totalEst)}h estimated (${pct}%)</div>
    </div>
    <div class="pc-steps"></div>
    <form class="pc-add-step">
      <input type="text" placeholder="New step name" required>
      <input type="number" placeholder="Est. hrs" min="0.25" step="0.25" style="width:80px" required>
      <button type="submit" class="forge-btn small">Add</button>
    </form>
    <div class="pc-footer">
      <span class="priority-badge"><span class="led-dot led-${urgency.level}"></span> ${levelLabel(urgency.level)}${urgency.daysLeft!=null && urgency.level==="overdue" ? " · "+Math.abs(urgency.daysLeft)+"d past due" : ""}${urgency.daysLeft!=null && (urgency.level==="high"||urgency.level==="medium") ? " · "+round2(urgency.hoursPerDay)+"h/day needed" : ""}</span>
    </div>
  `;

  const stepsWrap = card.querySelector(".pc-steps");
  p.steps.sort((a,b)=>a.order-b.order).forEach(step=> stepsWrap.appendChild(renderStepRow(step,p)));

  card.querySelector(".pc-del").addEventListener("click", ()=>{
    if(confirm(`Delete project "${p.name}"? This also removes its scheduled blocks.`)){
      state.projects = state.projects.filter(x=>x.id!==p.id);
      state.scheduleBlocks = state.scheduleBlocks.filter(b=>b.projectId!==p.id);
      state.trayItems = state.trayItems.filter(t=>t.projectId!==p.id);
      saveState(); renderProjects(); renderPlanner();
    }
  });

  const addStepForm = card.querySelector(".pc-add-step");
  addStepForm.addEventListener("submit", (e)=>{
    e.preventDefault();
    const inputs = addStepForm.querySelectorAll("input");
    const name = inputs[0].value.trim();
    const est = parseFloat(inputs[1].value)||0.5;
    if(!name) return;
    p.steps.push({ id:uid("step"), name, estHours:est, loggedHours:0, done:false, deadline:null, order:p.steps.length });
    saveState();
    renderProjects();
  });

  return card;
}

function renderStepRow(step, project){
  const row = document.createElement("div");
  row.className = "step-row" + (step.done?" done":"");
  const u = stepUrgency(step, project);
  row.innerHTML = `
    <button class="step-check ${step.done?"checked":""}" title="Mark ${step.done?"incomplete":"complete"}">
      ${step.done?'<svg viewBox="0 0 24 24"><use href="#icon-check"></use></svg>':""}
    </button>
    <span class="step-text">
      <span class="step-name">${escapeHtml(step.name)}</span>
      <span class="step-meta">
        <span class="led-dot led-${u.level}" style="display:inline-block;vertical-align:middle;margin-right:3px"></span>
        ${round2(step.loggedHours)}h / ${round2(step.estHours)}h${step.deadline?" · due "+formatDateHuman(step.deadline):""}
      </span>
    </span>
    <span class="step-actions">
      <button class="step-log-btn" title="Log time">+ Log</button>
      <button class="step-log-btn step-sched-btn" title="Schedule"><svg viewBox="0 0 24 24"><use href="#icon-clock"></use></svg></button>
      <button class="step-del" title="Delete step"><svg viewBox="0 0 24 24"><use href="#icon-trash"></use></svg></button>
    </span>
  `;
  row.querySelector(".step-check").addEventListener("click", ()=>{
    step.done = !step.done;
    saveState(); renderProjects();
  });
  const [logBtn, schedBtn] = row.querySelectorAll(".step-log-btn");
  logBtn.addEventListener("click", ()=> openLogTimeModal(step, project));
  schedBtn.addEventListener("click", ()=> pushStepToTray(step.id));
  row.querySelector(".step-del").addEventListener("click", ()=>{
    project.steps = project.steps.filter(s=>s.id!==step.id);
    saveState(); renderProjects();
  });
  return row;
}

function openLogTimeModal(step, project){
  const body = `
    <div class="field-group"><label>Log time for "${escapeHtml(step.name)}"</label>
      <div class="qa-row">
        <button type="button" class="forge-btn small" data-min="15">+15m</button>
        <button type="button" class="forge-btn small" data-min="30">+30m</button>
        <button type="button" class="forge-btn small" data-min="60">+1h</button>
      </div>
    </div>
    <div class="field-group"><label>Custom minutes</label>
      <div class="qa-row"><input type="number" id="log-custom-min" min="1" step="1" placeholder="e.g. 45">
      <button type="button" id="log-custom-btn" class="forge-btn small">Add</button></div>
    </div>
  `;
  openModal("Log Time", body, (root)=>{
    root.querySelectorAll("[data-min]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        step.loggedHours = round2(step.loggedHours + parseInt(btn.dataset.min,10)/60);
        saveState(); renderProjects(); closeModal();
      });
    });
    root.querySelector("#log-custom-btn").addEventListener("click", ()=>{
      const mins = parseInt(root.querySelector("#log-custom-min").value,10);
      if(mins>0){ step.loggedHours = round2(step.loggedHours + mins/60); saveState(); renderProjects(); closeModal(); }
    });
  });
}

/* ============================= MODAL SYSTEM ============================= */
function openModal(title, bodyHtml, onMount){
  $("#modal-root").innerHTML = `
    <div class="modal-title"><h3>${title}</h3><button class="modal-close"><svg viewBox="0 0 24 24"><use href="#icon-close"></use></svg></button></div>
    <div class="modal-body">${bodyHtml}</div>
  `;
  $("#modal-backdrop").classList.remove("hidden");
  $("#modal-root .modal-close").addEventListener("click", closeModal);
  if(onMount) onMount($("#modal-root"));
}
function closeModal(){
  $("#modal-backdrop").classList.add("hidden");
  $("#modal-root").innerHTML = "";
}
$("#modal-backdrop") && $("#modal-backdrop").addEventListener("click", (e)=>{ if(e.target.id==="modal-backdrop") closeModal(); });

/* ---------- New Project modal ---------- */
function openNewProjectModal(){
  const folderOpts = state.folders.map(f=>`<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("");
  const body = `
    <div class="field-group"><label>Project Name</label><input type="text" id="np-name" placeholder="e.g. Kitchen Renovation" required></div>
    <div class="field-row">
      <div class="field-group"><label>Folder</label><select id="np-folder">${folderOpts}</select></div>
      <div class="field-group"><label>Deadline</label><input type="date" id="np-deadline"></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost-btn" id="np-cancel">Cancel</button>
      <button type="button" class="forge-btn" id="np-save">Create Project</button>
    </div>
  `;
  openModal("New Project", body, (root)=>{
    root.querySelector("#np-cancel").addEventListener("click", closeModal);
    root.querySelector("#np-save").addEventListener("click", ()=>{
      const name = root.querySelector("#np-name").value.trim();
      if(!name) return;
      const folderId = root.querySelector("#np-folder").value;
      const deadline = root.querySelector("#np-deadline").value || null;
      state.projects.push({ id:uid("proj"), name, folderId, deadline, steps:[], createdAt:Date.now() });
      saveState();
      closeModal();
      renderProjects();
    });
  });
}

/* ---------- Manage Folders modal ---------- */
function openFolderManagerModal(){
  const render = (root)=>{
    const list = root.querySelector("#folder-manage-list");
    list.innerHTML = "";
    state.folders.forEach(f=>{
      const row = document.createElement("div");
      row.className = "folder-manage-row";
      row.innerHTML = `
        <div class="color-swatches">${FOLDER_PALETTE.map(c=>`<span class="color-swatch ${c.hex===f.hex?"selected":""}" style="background:${c.hex}" data-hex="${c.hex}"></span>`).join("")}</div>
        <input type="text" value="${escapeHtml(f.name)}">
        <button class="tc-del" title="Delete folder"><svg viewBox="0 0 24 24"><use href="#icon-trash"></use></svg></button>
      `;
      row.querySelectorAll(".color-swatch").forEach(sw=>{
        sw.addEventListener("click", ()=>{ f.hex = sw.dataset.hex; saveState(); render(root); });
      });
      row.querySelector("input").addEventListener("change", (e)=>{ f.name = e.target.value.trim()||f.name; saveState(); });
      row.querySelector(".tc-del").addEventListener("click", ()=>{
        if(state.folders.length<=1){ alert("You need at least one folder."); return; }
        const fallback = state.folders.find(x=>x.id!==f.id).id;
        state.projects.forEach(p=>{ if(p.folderId===f.id) p.folderId=fallback; });
        state.folders = state.folders.filter(x=>x.id!==f.id);
        if(state.settings.activeFolder===f.id) state.settings.activeFolder="all";
        saveState(); render(root);
      });
      list.appendChild(row);
    });
  };
  const body = `
    <div id="folder-manage-list"></div>
    <div class="qa-row" style="margin-top:10px">
      <input type="text" id="new-folder-name" placeholder="New folder name">
      <button type="button" id="add-folder-btn" class="forge-btn small">+ Add Folder</button>
    </div>
  `;
  openModal("Manage Folders", body, (root)=>{
    render(root);
    root.querySelector("#add-folder-btn").addEventListener("click", ()=>{
      const nameInput = root.querySelector("#new-folder-name");
      const name = nameInput.value.trim();
      if(!name) return;
      const usedColors = new Set(state.folders.map(f=>f.hex));
      const color = FOLDER_PALETTE.find(c=>!usedColors.has(c.hex)) || FOLDER_PALETTE[0];
      state.folders.push({ id:uid("folder"), name, hex:color.hex });
      nameInput.value = "";
      saveState(); render(root); renderFolderTabs();
    });
  });
}

/* ---------- Settings modal (incl. Google Calendar) ---------- */
function openSettingsModal(){
  const body = `
    <div class="settings-block">
      <h4>Timeline Hours</h4>
      <div class="field-row">
        <div class="field-group"><label>Day starts</label><input type="number" id="set-start" min="0" max="23" value="${state.settings.dayStartHour}"></div>
        <div class="field-group"><label>Day ends</label><input type="number" id="set-end" min="1" max="24" value="${state.settings.dayEndHour}"></div>
      </div>
    </div>
    <div class="settings-block">
      <h4>Google Calendar Sync</h4>
      <div class="field-group">
        <label>OAuth Client ID</label>
        <input type="text" id="set-gcal-client" placeholder="xxxx.apps.googleusercontent.com" value="${escapeHtml(state.settings.gcalClientId||"")}">
      </div>
      <div class="qa-row">
        <button type="button" id="gcal-connect-btn" class="forge-btn small">Connect &amp; Sync</button>
        <button type="button" id="gcal-sync-btn" class="ghost-btn small">Sync Now</button>
      </div>
      <div class="gcal-status ${runtime.gcalConnected?"connected":""}" id="gcal-status-el">
        ${runtime.gcalConnected ? "Connected — events are imported as dashed blocks on your timeline." : "Not connected."}
      </div>
      <p class="settings-note">Requires a free Google Cloud OAuth Client ID, and this app must be opened from a hosted https address (not a local file) for Google sign-in to work. See the included README for step-by-step setup.</p>
    </div>
    <div class="modal-actions">
      <button type="button" class="forge-btn" id="settings-save">Save</button>
    </div>
  `;
  openModal("Settings", body, (root)=>{
    root.querySelector("#settings-save").addEventListener("click", ()=>{
      state.settings.dayStartHour = clamp(parseInt(root.querySelector("#set-start").value,10)||6,0,23);
      state.settings.dayEndHour = clamp(parseInt(root.querySelector("#set-end").value,10)||23,state.settings.dayStartHour+1,24);
      state.settings.gcalClientId = root.querySelector("#set-gcal-client").value.trim();
      saveState();
      closeModal();
      renderPlanner();
    });
    root.querySelector("#gcal-connect-btn").addEventListener("click", ()=>{
      state.settings.gcalClientId = root.querySelector("#set-gcal-client").value.trim();
      saveState();
      connectGoogleCalendar();
    });
    root.querySelector("#gcal-sync-btn").addEventListener("click", ()=> syncGoogleCalendar());
  });
}

/* ============================= GOOGLE CALENDAR SYNC ============================= */
function ensureGISLoaded(cb){
  if(window.google && window.google.accounts && window.google.accounts.oauth2){ cb(); return; }
  const s = document.createElement("script");
  s.src = "https://accounts.google.com/gsi/client";
  s.async = true;
  s.onload = cb;
  s.onerror = ()=> alert("Could not reach Google's sign-in service. Check your internet connection.");
  document.head.appendChild(s);
}

function connectGoogleCalendar(){
  const clientId = state.settings.gcalClientId;
  if(!clientId){ alert("Enter your Google OAuth Client ID first."); return; }
  if(location.protocol==="file:"){
    alert("Google sign-in can't run when the app is opened directly from a file. Host it (e.g. GitHub Pages) and open it via https, then Google Calendar sync will work. See the README.");
    return;
  }
  ensureGISLoaded(()=>{
    try{
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        callback: (resp)=>{
          if(resp.error){ alert("Google sign-in failed: "+resp.error); return; }
          runtime.gcalToken = resp.access_token;
          runtime.gcalConnected = true;
          runtime.gcalExpiry = Date.now() + (resp.expires_in||3600)*1000;
          const statusEl = document.getElementById("gcal-status-el");
          if(statusEl){ statusEl.textContent = "Connected — events are imported as dashed blocks on your timeline."; statusEl.classList.add("connected"); }
          syncGoogleCalendar();
        },
      });
      tokenClient.requestAccessToken();
    }catch(err){
      console.error(err);
      alert("Google sign-in could not start. Double-check your OAuth Client ID and that this app's URL is registered as an authorized origin in Google Cloud Console.");
    }
  });
}

function syncGoogleCalendar(){
  if(!runtime.gcalToken){ alert("Connect to Google Calendar first."); return; }
  const timeMin = new Date(); timeMin.setDate(timeMin.getDate()-1);
  const timeMax = new Date(); timeMax.setDate(timeMax.getDate()+14);
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin.toISOString())}&timeMax=${encodeURIComponent(timeMax.toISOString())}&singleEvents=true&orderBy=startTime`;
  fetch(url, { headers:{ Authorization:"Bearer "+runtime.gcalToken } })
    .then(r=>{ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(data=>{
      if(!data.items) return;
      data.items.forEach(ev=>{
        if(!ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) return; // skip all-day events
        const gid = "gcal-"+ev.id;
        const existing = state.scheduleBlocks.find(b=>b.id===gid);
        const start = new Date(ev.start.dateTime);
        const end = new Date(ev.end.dateTime);
        const blockData = {
          id: gid, title: ev.summary || "(untitled event)",
          date: ymd(start), startMin: start.getHours()*60+start.getMinutes(),
          durationMin: Math.max(5, Math.round((end-start)/60000)),
          projectId:null, stepId:null, logged:false, source:"gcal",
        };
        if(existing) Object.assign(existing, blockData);
        else state.scheduleBlocks.push(blockData);
      });
      saveState();
      renderPlanner();
    })
    .catch(err=>{
      console.error(err);
      alert("Could not fetch Google Calendar events — your session may have expired. Try Connect again.");
    });
}

/* ============================= INIT ============================= */
function wireTopNav(){
  $$(".tab-btn").forEach(btn=> btn.addEventListener("click", ()=> switchView(btn.dataset.view)));
  $("#settings-btn").addEventListener("click", openSettingsModal);
}
function wirePlannerNav(){
  $("#day-prev").addEventListener("click", ()=>{ state.viewDate = addDays(state.viewDate,-1); saveState(); renderPlanner(); });
  $("#day-next").addEventListener("click", ()=>{ state.viewDate = addDays(state.viewDate,1); saveState(); renderPlanner(); });
  $("#day-today").addEventListener("click", ()=>{ state.viewDate = todayStr(); saveState(); renderPlanner(); });
}
function wireProjectsNav(){
  $("#new-project-btn").addEventListener("click", openNewProjectModal);
  $("#manage-folders-btn").addEventListener("click", openFolderManagerModal);
}

function init(){
  state = loadState();
  saveState();

  wireTopNav();
  wirePlannerNav();
  wireProjectsNav();
  wireQuickAdd();

  renderPlanner();
  renderProjects();

  reconcile();
  setInterval(renderClock, 1000);
  setInterval(reconcile, 30000);
  setInterval(()=>{ if(state.settings.activeFolder!==undefined) { /* keep now-line fresh */ if($("#view-planner").classList.contains("active")) renderTimeline(); } }, 60000);

  // periodic gcal re-sync while connected
  setInterval(()=>{ if(runtime.gcalConnected) syncGoogleCalendar(); }, 5*60000);

  // service worker (best-effort; ignored on file:// or unsupported)
  if("serviceWorker" in navigator && location.protocol!=="file:"){
    navigator.serviceWorker.register("service-worker.js").catch(()=>{});
  }
}

document.addEventListener("DOMContentLoaded", init);

})();
