/* ============================================================================================
   utils.js — fonctions transverses (aucune dépendance à Supabase)
   ============================================================================================ */

/* ---------- Divers ---------- */
export function uid(prefix){ return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
export function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
export function escapeAttr(s){ return escapeHtml(s).replace(/`/g,"&#96;"); }
export function formatDate(d){
  return new Date(d).toLocaleDateString("fr-FR", {day:"2-digit", month:"2-digit", year:"numeric"});
}

let toastTimer;
export function toast(msg){
  const t = document.getElementById("toast");
  if(!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove("show"), 2400);
}

/* ---------- Recherche floue (tolère fautes de frappe / pluriel) ---------- */
export function normalize(str){
  return (str||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
}
export function singularize(w){
  return w.replace(/(eaux|aux)$/,"al").replace(/[sx]$/,"");
}
function levenshtein(a,b){
  const m=a.length, n=b.length;
  const dp = Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++){
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j-1],dp[i-1][j],dp[i][j-1]);
  }
  return dp[m][n];
}
export function fuzzyMatch(query, target){
  const q = singularize(normalize(query));
  const t = singularize(normalize(target));
  if(!q || !t) return false;
  if(t.includes(q) || q.includes(t)) return true;
  const dist = levenshtein(q,t);
  return dist <= Math.max(1, Math.floor(Math.min(q.length,t.length)/3));
}

/* ---------- Formatage des ingrédients — format standardisé "X unité de X" ---------- */
export function isCountableUnit(unit){
  const u = (unit||"").toLowerCase().trim();
  return u === "" || u === "piece" || u === "pièce" || u === "pièces";
}
function pluralizeName(name, n){
  if(n <= 1) return name;
  return /s$|x$/i.test(name) ? name : name + "s";
}
export function formatQtyNumber(n){
  const r = Math.round(n*10)/10;
  return (Math.round(r)===r ? r.toString() : r.toFixed(1)).replace(".", ",");
}
/** Construit la phrase figée "200 g de Farine" / "3 pommes", enregistrée telle quelle en base. */
export function buildIngredientDisplayText(name, qty, unit){
  const countable = isCountableUnit(unit);
  const qtyStr = formatQtyNumber(qty);
  if(countable) return qtyStr + " " + pluralizeName(name, qty);
  const article = /^[aeiouyàâäéèêëîïôöùûüh]/i.test(name) ? "d’" : "de ";
  return qtyStr + " " + unit + " " + article + name;
}
/** Recalcule l'affichage avec un multiplicateur de portions (arrondi entier pour le dénombrable). */
export function scaledIngredientText(name, baseQty, unit, factor){
  const real = baseQty * factor;
  const countable = isCountableUnit(unit);
  const displayQty = countable ? Math.round(real) : Math.round(real*10)/10;
  return buildIngredientDisplayText(name, displayQty, unit);
}

/* ---------- Compression d'image côté client avant upload (PNG/JPEG) ---------- */
export function compressImage(file, maxDim = 1280, quality = 0.82){
  return new Promise((resolve, reject) => {
    if(!["image/png","image/jpeg"].includes(file.type)){
      reject(new Error("Formats acceptés : PNG et JPEG uniquement."));
      return;
    }
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if(width > maxDim || height > maxDim){
        const ratio = Math.min(maxDim/width, maxDim/height);
        width = Math.round(width*ratio); height = Math.round(height*ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => blob ? resolve({blob, ext: file.type==="image/png"?"png":"jpg"}) : reject(new Error("Compression échouée")), file.type, quality);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------- API Wake Lock (Mode Chef : empêche la mise en veille de l'écran) ---------- */
let wakeLockSentinel = null;
export async function requestWakeLock(){
  try{
    if("wakeLock" in navigator){
      wakeLockSentinel = await navigator.wakeLock.request("screen");
    }
  }catch(e){ /* refusé ou non supporté : silencieux, non bloquant */ }
}
export function releaseWakeLock(){
  if(wakeLockSentinel){ wakeLockSentinel.release().catch(()=>{}); wakeLockSentinel = null; }
}
document.addEventListener("visibilitychange", async () => {
  if(wakeLockSentinel !== null && document.visibilityState === "visible" && document.body.dataset.chefMode === "1"){
    await requestWakeLock();
  }
});

/* ---------- Minuteur (bip sonore + vibration) ---------- */
let timerInterval = null;
export function startTimer(totalSeconds, label, {onTick, onDone} = {}){
  clearInterval(timerInterval);
  let remaining = totalSeconds;
  onTick && onTick(remaining, false);
  timerInterval = setInterval(()=>{
    remaining--;
    onTick && onTick(remaining, false);
    if(remaining <= 0){
      clearInterval(timerInterval);
      playBeep();
      if(navigator.vibrate) navigator.vibrate([200,100,200,100,200]);
      onTick && onTick(0, true);
      onDone && onDone();
    }
  }, 1000);
  return () => clearInterval(timerInterval); // fonction d'arrêt
}
export function playBeep(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0,0.3,0.6].forEach(delay=>{
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, ctx.currentTime+delay);
      gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime+delay+0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+delay+0.28);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime+delay); osc.stop(ctx.currentTime+delay+0.3);
    });
  }catch(e){ /* audio non disponible */ }
}

/* ---------- Validateurs de formulaire ---------- */
export function isValidEmail(email){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
export function isValidUsername(u){ return /^[a-zA-Z0-9_\-]{3,20}$/.test(u); }

/* ---------- Tutoriel guidé générique (overlay + bulle) ---------- */
let tutState = { idx: 0, steps: [] };
export function openTutorial(steps){
  tutState = { idx: 0, steps };
  renderTutorialStep();
}
export function closeTutorial(){
  const hole = document.getElementById("tutorial-hole");
  const tip = document.getElementById("tutorial-tooltip");
  hole && hole.classList.remove("show");
  tip && tip.classList.remove("show");
}
function renderTutorialStep(){
  const { idx, steps } = tutState;
  if(idx >= steps.length){ closeTutorial(); return; }
  const stepDef = steps[idx];
  const el = document.querySelector(stepDef.sel);
  if(!el){ tutState.idx++; renderTutorialStep(); return; }
  el.scrollIntoView({block:"center", behavior:"smooth"});
  setTimeout(()=>{
    const rect = el.getBoundingClientRect();
    const hole = document.getElementById("tutorial-hole");
    hole.style.top = (rect.top-6)+"px"; hole.style.left = (rect.left-6)+"px";
    hole.style.width = (rect.width+12)+"px"; hole.style.height = (rect.height+12)+"px";
    hole.classList.add("show");

    const tip = document.getElementById("tutorial-tooltip");
    tip.querySelector("#tt-step-label").textContent = "Étape " + (idx+1) + " / " + steps.length;
    tip.querySelector("#tt-text").textContent = stepDef.text;
    const nextBtn = tip.querySelector("#tt-next");
    nextBtn.textContent = (idx === steps.length-1) ? "Terminer" : "Suivant";
    nextBtn.onclick = () => { tutState.idx++; renderTutorialStep(); };
    tip.querySelector("#tt-close").onclick = closeTutorial;
    tip.classList.add("show");
    let top = rect.bottom + 14;
    if(top + 140 > window.innerHeight) top = Math.max(10, rect.top - 150);
    tip.style.top = top+"px";
    tip.style.left = Math.min(Math.max(10, rect.left), window.innerWidth - 270) + "px";
  }, 260);
}

/* ---------- Positionnement générique d'un mini-popup près d'un élément ---------- */
export function popupPositionNear(anchorEl){
  const rect = anchorEl.getBoundingClientRect();
  let top = rect.bottom + 8, left = rect.left;
  if(left + 240 > window.innerWidth) left = window.innerWidth - 250;
  if(top + 220 > window.innerHeight) top = rect.top - 230;
  return { top: Math.max(8, top), left: Math.max(8, left) };
}
