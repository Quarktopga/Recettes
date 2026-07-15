/* ============================================================================================
   ui.js — routeur, écrans, et toute la logique d'interface. Point d'entrée de l'app.
   ============================================================================================ */
import { supabase, api, checkConnection } from "./supabase.js";
import {
  uid, escapeHtml, escapeAttr, formatDate, toast, normalize, fuzzyMatch,
  buildIngredientDisplayText, scaledIngredientText, formatQtyNumber, isCountableUnit,
  compressImage, requestWakeLock, releaseWakeLock, startTimer,
  isValidEmail, isValidUsername, openTutorial, closeTutorial, popupPositionNear
} from "./utils.js";

const PRESET_TAGS = ["Végétarien","Vegan","Sans gluten","Sans lactose","Rapide","Économique","Dessert","Healthy"];
const DIFFICULTY_LABELS = ["Très facile","Facile","Intermédiaire","Difficile","Expert"];
const TAB_SCREENS = ["home","friends","account"]; // écrans accessibles via la barre d'onglets basse

const state = {
  session: null,
  profile: null,
  screen: "auth",          // auth | home | edit | read | chef | account | friends | legal
  recipes: [],
  favoriteIds: [],
  currentRecipe: null,      // recette complète chargée pour lecture/édition
  editingId: null,
  draft: null,              // brouillon de recette en édition
  savedRange: null,
  activeStepId: null,
  chefStepIndex: 0,
  doneSteps: new Set()
};

const root = document.getElementById("screen-root");

/* ============================================================================================
   INITIALISATION & SESSION
   ============================================================================================ */
function fallbackProfile(){
  const email = state.session?.user?.email || "utilisateur";
  return { id: state.session.user.id, username: email.split("@")[0], avatar_url: null };
}

async function init(){
  // La navigation (onglets, FAB, modales) est câblée en tout premier lieu :
  // elle doit rester fonctionnelle même si Supabase est mal configuré.
  wireStaticUI();

  const conn = await checkConnection();
  if(!conn.ok) showConfigBanner(conn.message);

  try{
    const session = await api.auth.getSession();
    state.session = session;
    if(session){ await loadProfileAndData(); state.screen = "home"; }
  }catch(err){
    console.error(err);
    toast("Connexion à Supabase impossible — voir INSTRUCTIONS.md");
  }

  api.auth.onChange(async (session) => {
    state.session = session;
    if(session && !state.profile){
      try{ await loadProfileAndData(); }catch(err){ console.error(err); }
      if(state.screen === "auth") state.screen = "home";
      render();
    }
    if(!session){ state.profile = null; state.screen = "auth"; render(); }
  });

  render();
}

async function loadProfileAndData(){
  try{
    const { data: profile, error } = await api.profiles.getById(state.session.user.id);
    state.profile = (!error && profile) ? profile : fallbackProfile();
  }catch(err){
    console.error(err);
    state.profile = fallbackProfile();
    toast("Profil chargé en mode dégradé (vérifiez la configuration Supabase)");
  }
  await refreshRecipes();
}
async function refreshRecipes(){
  try{
    const { data } = await api.recipes.listVisibleToMe();
    state.recipes = data || [];
  }catch(err){ console.error(err); state.recipes = []; toast("Impossible de charger les recettes"); }
  try{
    const { data: favIds } = await api.personal.listFavoriteIds(state.session.user.id);
    state.favoriteIds = favIds || [];
  }catch(err){ state.favoriteIds = []; }
}

function showConfigBanner(message){
  const banner = document.getElementById("config-banner");
  banner.textContent = "⚠️ " + message;
  banner.classList.add("show");
}

/* ============================================================================================
   NAVIGATION STATIQUE — onglets bas, FAB, modales (câblée une seule fois, indépendante des données)
   ============================================================================================ */
function wireStaticUI(){
  document.querySelectorAll("#tab-bar .tab-item").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      if(state.session && !state.profile){ try{ await loadProfileAndData(); }catch(e){} }
      goto(btn.dataset.tab);
    });
  });
  document.getElementById("add-fab").addEventListener("click", ()=> openEditScreen(null));
  document.getElementById("help-fab").addEventListener("click", ()=>{
    const steps = TUTORIALS[state.screen] || [];
    if(steps.length === 0){ toast("Pas d'aide disponible sur cet écran."); return; }
    openTutorial(steps);
  });
  document.getElementById("modal-backdrop").addEventListener("click", (e)=>{
    if(e.target.id === "modal-backdrop") closeModal();
  });
  document.getElementById("config-banner").addEventListener("click", (e)=> e.currentTarget.classList.remove("show"));
}

/* ============================================================================================
   ROUTEUR
   ============================================================================================ */
function goto(screen){ state.screen = screen; closeTutorial(); render(); window.scrollTo(0,0); }
function render(){
  const loggedIn = !!state.session;
  document.getElementById("tab-bar").style.display = (loggedIn && TAB_SCREENS.includes(state.screen)) ? "flex" : "none";
  document.querySelectorAll("#tab-bar .tab-item").forEach(el=> el.classList.toggle("active", el.dataset.tab === state.screen));
  document.getElementById("add-fab").style.display = (loggedIn && state.screen === "home") ? "flex" : "none";
  document.getElementById("help-fab").style.display = (loggedIn && (TUTORIALS[state.screen]||[]).length) ? "flex" : "none";
  switch(state.screen){
    case "auth": return renderAuth();
    case "home": return renderHome();
    case "edit": return renderEdit();
    case "read": return renderRead();
    case "chef": return renderChef();
    case "account": return renderAccount();
    case "friends": return renderFriends();
    case "legal": return renderLegal();
    default: return renderAuth();
  }
}

/* ============================================================================================
   ÉCRAN AUTH — inscription / connexion
   ============================================================================================ */
function renderAuth(){
  root.innerHTML = `
  <div class="auth-screen">
    <h1 class="brand">Mon carnet<span class="dot">.</span></h1>
    <div class="tabs">
      <button class="tab-btn active" data-tab="signin">Connexion</button>
      <button class="tab-btn" data-tab="signup">Inscription</button>
    </div>
    <form id="signin-form" class="auth-form">
      <div class="field"><label>E-mail</label><input type="email" id="si-email" required></div>
      <div class="field"><label>Mot de passe</label><input type="password" id="si-pass" required></div>
      <button class="primary-btn" type="submit">Se connecter</button>
    </form>
    <form id="signup-form" class="auth-form hidden">
      <div class="field"><label>Pseudo</label><input type="text" id="su-username" required></div>
      <div class="field"><label>E-mail</label><input type="email" id="su-email" required></div>
      <div class="field"><label>Mot de passe</label><input type="password" id="su-pass" required></div>
      <div class="field"><label>Confirmation</label><input type="password" id="su-pass2" required></div>
      <button class="primary-btn" type="submit">Créer mon compte</button>
    </form>
    <p class="legal-link"><a href="#" id="open-legal">Mentions légales &amp; confidentialité « Zéro cookie »</a></p>
  </div>`;

  root.querySelectorAll(".tab-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      root.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      root.querySelector("#signin-form").classList.toggle("hidden", btn.dataset.tab !== "signin");
      root.querySelector("#signup-form").classList.toggle("hidden", btn.dataset.tab !== "signup");
    });
  });

  root.querySelector("#signin-form").addEventListener("submit", async (e)=>{
    e.preventDefault();
    const email = root.querySelector("#si-email").value.trim();
    const password = root.querySelector("#si-pass").value;
    const { error } = await api.auth.signIn({ email, password });
    if(error){ toast("Connexion impossible : identifiants invalides."); return; }
    await loadProfileAndData();
    goto("home");
  });

  root.querySelector("#signup-form").addEventListener("submit", async (e)=>{
    e.preventDefault();
    const username = root.querySelector("#su-username").value.trim();
    const email = root.querySelector("#su-email").value.trim();
    const pass = root.querySelector("#su-pass").value;
    const pass2 = root.querySelector("#su-pass2").value;
    if(!isValidUsername(username)){ toast("Pseudo : 3 à 20 caractères (lettres, chiffres, _ -)"); return; }
    if(!isValidEmail(email)){ toast("E-mail invalide"); return; }
    if(pass.length < 8){ toast("Le mot de passe doit contenir au moins 8 caractères"); return; }
    if(pass !== pass2){ toast("Les mots de passe ne correspondent pas"); return; }
    const { data: available } = await api.profiles.isUsernameAvailable(username);
    if(available === false){ toast("Ce pseudo est déjà pris"); return; }
    const { error } = await api.auth.signUp({ email, password: pass, username });
    if(error){ toast("Inscription impossible : " + error.message); return; }
    toast("Compte créé ! Vérifiez votre e-mail si la confirmation est requise.");
    await loadProfileAndData();
    goto("home");
  });

  root.querySelector("#open-legal").addEventListener("click", (e)=>{ e.preventDefault(); goto("legal"); });
}

/* ============================================================================================
   ÉCRAN ACCUEIL — liste des recettes, recherche, frigo vide
   ============================================================================================ */
function avatarHtml(profile, size=36){
  if(profile && profile.avatar_url){
    return `<img class="avatar" style="width:${size}px;height:${size}px" src="${escapeAttr(profile.avatar_url)}" alt="">`;
  }
  const letter = profile && profile.username ? profile.username[0].toUpperCase() : "?";
  return `<div class="avatar avatar-letter" style="width:${size}px;height:${size}px">${escapeHtml(letter)}</div>`;
}

function recipeMatchesQuery(r, q){
  if(!q) return true;
  const tokens = q.split(/[,\s]+/).filter(Boolean);
  if(tokens.some(t => fuzzyMatch(t, r.name))) return true;
  return tokens.every(t => (r.recipe_ingredients||[]).some(ing => fuzzyMatch(t, ing.name)));
}

function visibilityLabel(v){ return { private:"Privé", friends:"Amis", public:"Public" }[v] || v; }

function recipeCardHtml(r){
  const isFav = state.favoriteIds.includes(r.id);
  const tags = (r.recipe_tags||[]).map(t=>t.tags?.label).filter(Boolean);
  const photo = r.photo_url ? `<div class="card-photo"><img src="${escapeAttr(r.photo_url)}" alt=""></div>` : "";
  return `
  <div class="recipe-card" data-id="${r.id}">
    <div class="card-top">
      ${photo}
      <div class="card-main">
        <h3>${escapeHtml(r.name)}</h3>
        <div class="card-sub">Créée par ${escapeHtml(r.owner?.username||"?")} le ${formatDate(r.created_at)}. <span class="vis-badge vis-${r.visibility}">${visibilityLabel(r.visibility)}</span></div>
      </div>
      <button class="fav-btn ${isFav?"active":""}" data-id="${r.id}" title="Favori">❤</button>
    </div>
    <div class="card-meta">
      <span class="meta-chip">⏱ ${r.prep_time_minutes ? r.prep_time_minutes+" min" : "—"}</span>
      <span class="meta-chip">${"●".repeat(r.difficulty||1)}${"○".repeat(5-(r.difficulty||1))}</span>
      ${tags.map(t=>`<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}
    </div>
  </div>`;
}

function renderHome(){
  const q = (document.getElementById("home-search-val") || {}).value || "";
  root.innerHTML = `
  <div class="topbar">
    <h1 class="brand">Mon carnet<span class="dot">.</span></h1>
    <div class="search-row">
      <div class="search-box">
        <input type="text" id="home-search-val" placeholder="Chercher par ingrédient…" value="${escapeAttr(q)}">
      </div>
      <button class="icon-btn" id="fridge-btn" title="Mode frigo vide">🧊</button>
    </div>
  </div>
  <div class="recipe-list" id="recipe-list"></div>`;

  document.getElementById("home-search-val").addEventListener("input", renderRecipeList);
  document.getElementById("fridge-btn").addEventListener("click", openFridgeMode);
  renderRecipeList();
}

function renderRecipeList(list){
  const q = document.getElementById("home-search-val").value.trim();
  const items = list || state.recipes.filter(r => recipeMatchesQuery(r, q));
  const container = document.getElementById("recipe-list");
  if(items.length === 0){
    container.innerHTML = `<div class="empty-state">Aucune recette. Utilisez le bouton ＋ pour en créer une.</div>`;
    return;
  }
  container.innerHTML = items.map(recipeCardHtml).join("");
  container.querySelectorAll(".recipe-card").forEach(card=>{
    card.addEventListener("click", (e)=>{
      if(e.target.closest(".fav-btn")) return;
      openReadScreen(card.dataset.id);
    });
  });
  container.querySelectorAll(".fav-btn").forEach(btn=>{
    btn.addEventListener("click", async (e)=>{
      e.stopPropagation();
      const isFav = state.favoriteIds.includes(btn.dataset.id);
      const { data } = await api.personal.toggleFavorite(btn.dataset.id, state.session.user.id, isFav);
      if(data) state.favoriteIds.push(btn.dataset.id); else state.favoriteIds = state.favoriteIds.filter(id=>id!==btn.dataset.id);
      renderRecipeList();
    });
  });
}

/* ---- Mode frigo vide ---- */
function openFridgeMode(){
  const names = new Map();
  state.recipes.forEach(r => (r.recipe_ingredients||[]).forEach(ing=>{
    const key = normalize(ing.name);
    if(!names.has(key)) names.set(key, ing.name);
  }));
  const list = Array.from(names.values()).sort((a,b)=>a.localeCompare(b));
  const checked = new Set();
  openModal(`
    <h3>🧊 Mode frigo vide</h3>
    <p class="hint">Cochez ce que vous avez sous la main.</p>
    <div class="chip-grid" id="fridge-grid">
      ${list.map(n=>`<div class="chip" data-name="${escapeAttr(n)}">${escapeHtml(n)}</div>`).join("") || '<span class="hint">Aucun ingrédient connu.</span>'}
    </div>
    <button class="primary-btn" id="fridge-apply">Voir les recettes</button>
  `);
  document.querySelectorAll("#fridge-grid .chip").forEach(chip=>{
    chip.addEventListener("click", ()=>{
      const n = chip.dataset.name;
      checked.has(n) ? checked.delete(n) : checked.add(n);
      chip.classList.toggle("checked");
    });
  });
  document.getElementById("fridge-apply").addEventListener("click", ()=>{
    closeModal();
    if(checked.size === 0){ renderRecipeList(); return; }
    const scored = state.recipes.map(r=>{
      const ings = r.recipe_ingredients || [];
      const missing = ings.filter(ing => !Array.from(checked).some(h => fuzzyMatch(h, ing.name)));
      return { r, missing: missing.length, total: ings.length };
    }).filter(x=>x.total>0).sort((a,b)=>a.missing-b.missing);
    renderRecipeList(scored.map(s=>s.r));
    toast("Résultats du frigo vide 🧊");
  });
}

/* ============================================================================================
   MODAL générique
   ============================================================================================ */
function openModal(innerHtml){
  const backdrop = document.getElementById("modal-backdrop");
  backdrop.querySelector(".modal-sheet").innerHTML = `<div class="modal-close-bar"></div>` + innerHtml;
  backdrop.classList.add("show");
}
function closeModal(){ document.getElementById("modal-backdrop").classList.remove("show"); }

/* ============================================================================================
   ÉCRAN COMPTE
   ============================================================================================ */
function renderAccount(){
  if(!state.profile){
    root.innerHTML = `<div class="form-section"><p class="hint">Chargement du profil…</p>
      <button class="mini-btn" id="retry-profile">Réessayer</button></div>`;
    document.getElementById("retry-profile").addEventListener("click", async ()=>{ await loadProfileAndData(); render(); });
    return;
  }
  const p = state.profile;
  root.innerHTML = `
  <div class="back-row"><span>Mon compte</span></div>
  <div class="form-section">
    <div class="account-avatar-row">
      ${avatarHtml(p, 72)}
      <label class="file-btn">Changer la photo<input type="file" id="avatar-file" accept="image/png,image/jpeg" hidden></label>
    </div>
    <div class="field"><label>Pseudo</label><input type="text" id="acc-username" value="${escapeAttr(p.username)}"></div>
    <div class="field"><label>E-mail</label><input type="email" id="acc-email" value="${escapeAttr(state.session.user.email||"")}"></div>
    <div class="field"><label>Nouveau mot de passe (optionnel)</label><input type="password" id="acc-pass" placeholder="Laisser vide pour ne pas changer"></div>
    <button class="primary-btn" id="acc-save">Enregistrer</button>
    <button class="danger-btn" id="acc-signout">Se déconnecter</button>
    <button class="danger-btn outline" id="acc-delete">Supprimer définitivement mon compte</button>
    <p class="legal-link"><a href="#" id="open-legal">Mentions légales &amp; confidentialité « Zéro cookie »</a></p>
  </div>`;

  document.getElementById("open-legal").addEventListener("click", (e)=>{ e.preventDefault(); goto("legal"); });

  document.getElementById("avatar-file").addEventListener("change", async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    try{
      const { blob, ext } = await compressImage(file, 512, 0.85);
      const { data: url, error } = await api.storage.uploadAvatar(state.session.user.id, blob, ext);
      if(error){ toast("Échec du téléversement : " + error.message); return; }
      await api.profiles.update(state.session.user.id, { avatar_url: url });
      state.profile.avatar_url = url;
      renderAccount();
      toast("Photo de profil mise à jour");
    }catch(err){ toast(err.message); }
  });

  document.getElementById("acc-save").addEventListener("click", async ()=>{
    const username = document.getElementById("acc-username").value.trim();
    const email = document.getElementById("acc-email").value.trim();
    const pass = document.getElementById("acc-pass").value;
    try{
      if(username !== p.username){
        if(!isValidUsername(username)){ toast("Pseudo invalide (3-20 caractères, lettres/chiffres/_/-)"); return; }
        const { data: available } = await api.profiles.isUsernameAvailable(username, state.session.user.id);
        if(available === false){ toast("Ce pseudo est déjà pris"); return; }
      }
      const patch = {};
      if(email !== state.session.user.email) patch.email = email;
      if(pass) patch.password = pass;
      if(Object.keys(patch).length){
        const { error } = await supabase.auth.updateUser(patch);
        if(error){ toast("Erreur : " + error.message); return; }
      }
      const { error: profErr } = await api.profiles.update(state.session.user.id, { username });
      if(profErr){ toast("Erreur : " + profErr.message); return; }
      state.profile.username = username;
      toast("Profil mis à jour");
      goto("home");
    }catch(err){ toast("Erreur : " + err.message); }
  });

  document.getElementById("acc-signout").addEventListener("click", async ()=>{
    await api.auth.signOut(); goto("auth");
  });
  document.getElementById("acc-delete").addEventListener("click", async ()=>{
    if(!confirm("Supprimer définitivement votre compte et toutes vos données ? Cette action est irréversible.")) return;
    const { error } = await api.auth.deleteAccount();
    if(error){ toast("Échec de la suppression : " + error.message); return; }
    goto("auth");
  });
}

/* ============================================================================================
   ÉCRAN AMIS
   ============================================================================================ */
async function renderFriends(){
  root.innerHTML = `
  <div class="back-row"><span>Amis</span></div>
  <div class="form-section">
    <div class="search-box"><input type="text" id="friend-search" placeholder="Pseudo exact…"></div>
    <button class="primary-btn" id="friend-search-btn">Rechercher</button>
    <div id="friend-search-result"></div>
    <h4 class="section-title">Demandes reçues</h4>
    <div id="friend-incoming"><span class="hint">Chargement…</span></div>
    <h4 class="section-title">Demandes envoyées</h4>
    <div id="friend-outgoing"><span class="hint">Chargement…</span></div>
    <h4 class="section-title">Mes amis</h4>
    <div id="friend-list"><span class="hint">Chargement…</span></div>
    <h4 class="section-title">Utilisateurs bloqués</h4>
    <div id="blocked-list"><span class="hint">Chargement…</span></div>
  </div>`;

  const mine = state.session.user.id;

  // Le bouton de recherche est câblé immédiatement : il ne doit jamais dépendre
  // de la réussite d'un appel réseau précédent.
  document.getElementById("friend-search-btn").addEventListener("click", async ()=>{
    const username = document.getElementById("friend-search").value.trim();
    if(!username) return;
    const box = document.getElementById("friend-search-result");
    box.innerHTML = '<span class="hint">Recherche…</span>';
    try{
      const { data: found, error } = await api.profiles.searchByExactUsername(username);
      if(error) throw error;
      if(!found){ box.innerHTML = '<span class="hint">Aucun utilisateur avec ce pseudo.</span>'; return; }
      if(found.id === mine){ box.innerHTML = '<span class="hint">C’est vous !</span>'; return; }
      box.innerHTML = `<div class="friend-row">${avatarHtml(found,32)}<span>${escapeHtml(found.username)}</span><div class="spacer"></div><button class="mini-btn accept" id="send-req">Ajouter</button><button class="mini-btn danger" id="block-user">Bloquer</button></div>`;
      document.getElementById("send-req").addEventListener("click", async ()=>{
        const { error } = await api.friends.sendRequest(mine, found.id);
        if(error){ toast("Déjà envoyé, déjà amis, ou utilisateur bloqué"); return; }
        toast("Demande envoyée"); renderFriends();
      });
      document.getElementById("block-user").addEventListener("click", async ()=>{
        if(!confirm("Bloquer cet utilisateur ?")) return;
        await api.blocks.block(mine, found.id);
        toast("Utilisateur bloqué"); renderFriends();
      });
    }catch(err){
      box.innerHTML = '<span class="hint">Erreur de recherche : ' + escapeHtml(err.message||"inconnue") + '</span>';
    }
  });
  document.getElementById("friend-search").addEventListener("keydown", (e)=>{
    if(e.key === "Enter") document.getElementById("friend-search-btn").click();
  });

  const renderRow = (f, kind) => {
    const other = f.requester_id === mine ? f.addressee : f.requester;
    const otherId = f.requester_id === mine ? f.addressee_id : f.requester_id;
    let actions = "";
    if(kind === "incoming") actions = `<button class="mini-btn accept" data-id="${f.id}">Accepter</button><button class="mini-btn decline" data-id="${f.id}">Refuser</button>`;
    if(kind === "outgoing") actions = `<button class="mini-btn decline" data-id="${f.id}">Annuler</button>`;
    if(kind === "friend") actions = `<button class="mini-btn danger" data-block="${otherId}">Bloquer</button><button class="mini-btn decline" data-id="${f.id}">Supprimer</button>`;
    return `<div class="friend-row">${avatarHtml(other,32)}<span>${escapeHtml(other?.username||"?")}</span><div class="spacer"></div>${actions}</div>`;
  };

  try{
    const { data, error } = await api.friends.listAll(mine);
    if(error) throw error;
    document.getElementById("friend-incoming").innerHTML = data.incoming.map(f=>renderRow(f,"incoming")).join("") || '<span class="hint">Aucune</span>';
    document.getElementById("friend-outgoing").innerHTML = data.outgoing.map(f=>renderRow(f,"outgoing")).join("") || '<span class="hint">Aucune</span>';
    document.getElementById("friend-list").innerHTML = data.friends.map(f=>renderRow(f,"friend")).join("") || '<span class="hint">Aucun ami pour le moment</span>';

    document.querySelectorAll(".mini-btn.accept[data-id]").forEach(b=>b.addEventListener("click", async ()=>{ await api.friends.respond(b.dataset.id, true); renderFriends(); }));
    document.querySelectorAll(".mini-btn.decline[data-id]").forEach(b=>b.addEventListener("click", async ()=>{ await api.friends.remove(b.dataset.id); renderFriends(); }));
    document.querySelectorAll("[data-block]").forEach(b=>b.addEventListener("click", async ()=>{
      if(!confirm("Bloquer cet utilisateur ? Vous ne verrez plus son contenu et il ne pourra plus interagir avec vous.")) return;
      await api.blocks.block(mine, b.dataset.block);
      toast("Utilisateur bloqué"); renderFriends();
    }));
  }catch(err){
    ["friend-incoming","friend-outgoing","friend-list"].forEach(id=>{
      document.getElementById(id).innerHTML = '<span class="hint">Erreur de chargement : ' + escapeHtml(err.message||"inconnue") + '</span>';
    });
  }

  try{
    const { data: blocked, error } = await api.blocks.list(mine);
    if(error) throw error;
    document.getElementById("blocked-list").innerHTML = (blocked && blocked.length)
      ? blocked.map(b=>`<div class="friend-row">${avatarHtml(b.blocked,32)}<span>${escapeHtml(b.blocked?.username||"?")}</span><div class="spacer"></div><button class="mini-btn decline" data-unblock="${b.blocked_id}">Débloquer</button></div>`).join("")
      : '<span class="hint">Aucun</span>';
    document.querySelectorAll("[data-unblock]").forEach(b=>b.addEventListener("click", async ()=>{
      await api.blocks.unblock(mine, b.dataset.unblock);
      toast("Utilisateur débloqué"); renderFriends();
    }));
  }catch(err){
    document.getElementById("blocked-list").innerHTML = '<span class="hint">Erreur de chargement</span>';
  }
}

/* ============================================================================================
   ÉCRAN LÉGAL
   ============================================================================================ */
function renderLegal(){
  root.innerHTML = `
  <div class="back-row"><button id="back-btn">←</button><span>Mentions légales</span></div>
  <div class="form-section legal-text">
    <h3>Politique de confidentialité — Zéro cookie</h3>
    <p>Ce site n'utilise aucun cookie tiers ni traceur publicitaire. L'authentification et la session
    reposent exclusivement sur le stockage local sécurisé de votre navigateur (LocalStorage), à des fins
    strictement techniques (maintien de connexion).</p>
    <p>Vos habitudes alimentaires, vos recettes privées et votre historique de préparation restent
    strictement privés et ne sont jamais partagés sans votre action explicite.</p>
    <h3>Propriété intellectuelle</h3>
    <p><strong>Une recette partagée (Amis ou Public) perd immédiatement sa propriété intellectuelle.</strong>
    Toute personne y ayant accès peut la dupliquer dans son propre espace, sans lien de généalogie avec l'original.</p>
    <h3>Modération</h3>
    <p>Toute recette ayant fait l'objet de plusieurs signalements est automatiquement masquée dans l'attente d'une revue.</p>
  </div>`;
  document.getElementById("back-btn").addEventListener("click", ()=> goto(state.session ? "account" : "auth"));
}

/* ============================================================================================
   ÉCRAN ÉDITION — création / modification
   ============================================================================================ */
function openEditScreen(existing){
  state.editingId = existing ? existing.id : null;
  state.draft = existing ? {
    name: existing.name, servings: existing.servings || 4, prep_time_minutes: existing.prep_time_minutes || 0,
    difficulty: existing.difficulty || 1,
    steps: (existing.recipe_steps||[]).sort((a,b)=>a.position-b.position).map(s=>({id: s.id || uid("step"), html: s.content})),
    tags: (existing.recipe_tags||[]).map(t=>t.tags?.label).filter(Boolean),
    photo_url: existing.photo_url || null, newPhotoBlob: null,
    visibility: existing.visibility || "private", edit_text_policy: existing.edit_text_policy || "owner_only",
    edit_photo_policy: existing.edit_photo_policy || "owner_only"
  } : {
    name: "", servings: 4, prep_time_minutes: 0, difficulty: 1, steps: [], tags: [],
    photo_url: null, newPhotoBlob: null, visibility: "private", edit_text_policy: "owner_only", edit_photo_policy: "owner_only"
  };
  goto("edit");
}

const TUTORIALS = {
  home: [
    { sel:"#home-search-val", text:"Recherchez par ingrédient : la recherche tolère fautes de frappe et pluriel." },
    { sel:"#fridge-btn", text:"Mode Frigo vide : cochez ce que vous avez, on vous montre les recettes réalisables." },
    { sel:"#add-fab", text:"Créez une nouvelle recette." }
  ],
  edit: [
    { sel:"#draft-name", text:"Donnez un nom à votre recette, définissez le temps de préparation et la difficulté." },
    { sel:"#tag-box", text:"Choisissez des tags (végétarien, sans gluten…)." },
    { sel:"#steps-container", text:"Tapez « @ » dans une étape pour taguer un aliment ou un ustensile." },
    { sel:"#visibility-box", text:"Choisissez qui peut voir — et éventuellement modifier — votre recette." }
  ],
  read: [
    { sel:"#servings-control", text:"Ajustez le nombre de personnes : les quantités se recalculent partout." },
    { sel:"#chef-mode-btn", text:"Lancez le Mode Chef pour un pas-à-pas qui garde l'écran allumé." },
    { sel:"#comment-box", text:"Consultez ou laissez un commentaire, avec la visibilité de votre choix." }
  ],
  friends: [
    { sel:"#friend-search", text:"Recherchez un ami par son pseudo exact." },
    { sel:"#blocked-list", text:"Retrouvez ici les utilisateurs que vous avez bloqués." }
  ],
  account: [
    { sel:".account-avatar-row", text:"Changez votre photo de profil, ou laissez l'initiale de votre pseudo par défaut." },
    { sel:"#acc-delete", text:"Vous pouvez supprimer définitivement votre compte et toutes vos données à tout moment." }
  ]
};

function renderEdit(){
  const d = state.draft;
  root.innerHTML = `
  <div class="back-row"><button id="back-btn">←</button><span>${state.editingId ? "Modifier la recette" : "Nouvelle recette"}</span></div>
  <div class="form-section">
    <div class="field name"><label>Nom de la recette</label><input type="text" id="draft-name" value="${escapeAttr(d.name)}"></div>
    <div class="two-col">
      <div class="field"><label>Personnes (base)</label>
        <div class="stepper"><button id="serv-minus" type="button">−</button><div class="val" id="serv-val">${d.servings}</div><button id="serv-plus" type="button">+</button></div>
      </div>
      <div class="field"><label>Temps de préparation (min)</label><input type="number" id="draft-prep" min="0" value="${d.prep_time_minutes}"></div>
    </div>
    <div class="field"><label>Difficulté</label>
      <div class="difficulty-picker" id="difficulty-picker">
        ${[1,2,3,4,5].map(n=>`<button type="button" class="diff-dot ${n<=d.difficulty?"on":""}" data-n="${n}" title="${DIFFICULTY_LABELS[n-1]}">●</button>`).join("")}
      </div>
    </div>
    <div class="field"><label>Photo de la recette</label>
      <label class="file-btn">${d.photo_url||d.newPhotoBlob ? "Changer la photo" : "Ajouter une photo"}<input type="file" id="photo-file" accept="image/png,image/jpeg" hidden></label>
      <div id="photo-preview">${d.photo_url ? `<img src="${escapeAttr(d.photo_url)}">` : ""}</div>
    </div>
    <div class="box" id="tag-box"><h4>Tags</h4>
      <div class="chip-grid" id="tag-grid">
        ${PRESET_TAGS.map(t=>`<div class="chip ${d.tags.includes(t)?"checked":""}" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</div>`).join("")}
      </div>
    </div>

    <div class="box" id="ing-box"><h4>🥕 Ingrédients</h4><ul id="ing-box-list"></ul></div>
    <div class="box tools" id="tool-box"><h4>🔧 Matériel requis</h4><ul id="tool-box-list"></ul></div>

    <div class="steps-header"><h3>Étapes</h3></div>
    <div id="steps-container"></div>
    <button id="add-step-btn" type="button">+ Ajouter une étape</button>

    <div class="box" id="visibility-box"><h4>Diffusion</h4>
      <div class="field"><label>Visibilité</label>
        <select id="draft-visibility">
          <option value="private" ${d.visibility==="private"?"selected":""}>Privé</option>
          <option value="friends" ${d.visibility==="friends"?"selected":""}>Amis</option>
          <option value="public" ${d.visibility==="public"?"selected":""}>Public</option>
        </select>
      </div>
      <div class="field"><label>Modification du texte</label>
        <select id="draft-edit-text">
          <option value="owner_only" ${d.edit_text_policy==="owner_only"?"selected":""}>Propriétaire uniquement</option>
          <option value="everyone" ${d.edit_text_policy==="everyone"?"selected":""}>Tout le monde (accès)</option>
        </select>
      </div>
      <div class="field"><label>Modification de la photo</label>
        <select id="draft-edit-photo">
          <option value="owner_only" ${d.edit_photo_policy==="owner_only"?"selected":""}>Propriétaire uniquement</option>
          <option value="everyone" ${d.edit_photo_policy==="everyone"?"selected":""}>Tout le monde (accès)</option>
        </select>
      </div>
      <p class="hint">⚠️ Une recette partagée (Amis ou Public) perd immédiatement sa propriété intellectuelle.</p>
    </div>

    <button class="primary-btn" id="save-recipe-btn">Enregistrer la recette</button>
  </div>`;

  document.getElementById("back-btn").addEventListener("click", ()=>goto("home"));
  document.getElementById("draft-name").addEventListener("input", e=> d.name = e.target.value);
  document.getElementById("draft-prep").addEventListener("input", e=> d.prep_time_minutes = parseInt(e.target.value)||0);
  document.getElementById("serv-minus").addEventListener("click", ()=>{ d.servings = Math.max(1,d.servings-1); document.getElementById("serv-val").textContent = d.servings; });
  document.getElementById("serv-plus").addEventListener("click", ()=>{ d.servings = Math.min(50,d.servings+1); document.getElementById("serv-val").textContent = d.servings; });
  document.getElementById("draft-visibility").addEventListener("change", e=> d.visibility = e.target.value);
  document.getElementById("draft-edit-text").addEventListener("change", e=> d.edit_text_policy = e.target.value);
  document.getElementById("draft-edit-photo").addEventListener("change", e=> d.edit_photo_policy = e.target.value);

  root.querySelectorAll(".diff-dot").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      d.difficulty = parseInt(btn.dataset.n);
      root.querySelectorAll(".diff-dot").forEach(b=> b.classList.toggle("on", parseInt(b.dataset.n) <= d.difficulty));
    });
  });
  root.querySelectorAll("#tag-grid .chip").forEach(chip=>{
    chip.addEventListener("click", ()=>{
      const t = chip.dataset.tag;
      if(d.tags.includes(t)) d.tags = d.tags.filter(x=>x!==t); else d.tags.push(t);
      chip.classList.toggle("checked");
    });
  });
  document.getElementById("photo-file").addEventListener("change", async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    try{
      const { blob, ext } = await compressImage(file, 1280, 0.82);
      d.newPhotoBlob = { blob, ext };
      document.getElementById("photo-preview").innerHTML = `<img src="${URL.createObjectURL(blob)}">`;
    }catch(err){ toast(err.message); }
  });

  document.getElementById("add-step-btn").addEventListener("click", ()=>{ d.steps.push({id: uid("step"), html: ""}); renderStepsEditor(); });
  renderStepsEditor();
  updateLiveAggregates();

  document.getElementById("save-recipe-btn").addEventListener("click", saveRecipe);
}

/* ---- Éditeur d'étapes (texte enrichi + tags @) ---- */
function renderStepsEditor(){
  const container = document.getElementById("steps-container");
  const d = state.draft;
  container.innerHTML = "";
  d.steps.forEach((step, idx)=>{
    const block = document.createElement("div");
    block.className = "step-block";
    block.innerHTML = `
      <div class="step-num">${idx+1}</div>
      <div class="step-toolbar">
        <button type="button" data-cmd="bold"><b>G</b></button>
        <button type="button" data-cmd="italic"><i>I</i></button>
        <button type="button" data-cmd="underline"><u>S</u></button>
        <button type="button" data-cmd="timer">⏱️</button>
        <button type="button" class="del-step">✕</button>
      </div>
      <div class="step-text" contenteditable="true" data-step-id="${step.id}">${step.html}</div>`;
    container.appendChild(block);
    const editable = block.querySelector(".step-text");

    block.querySelectorAll("[data-cmd]").forEach(btn=>{
      btn.addEventListener("mousedown", (e)=>{
        e.preventDefault(); editable.focus();
        const cmd = btn.dataset.cmd;
        if(cmd === "timer"){
          const sel = window.getSelection();
          if(sel.rangeCount) state.savedRange = sel.getRangeAt(0).cloneRange();
          state.activeStepId = step.id;
          openTimerInsertPopup(btn);
        }else{
          document.execCommand(cmd, false, null);
          syncStepHtml(step.id, editable);
        }
      });
    });
    block.querySelector(".del-step").addEventListener("click", ()=>{
      d.steps = d.steps.filter(s=>s.id!==step.id);
      renderStepsEditor(); updateLiveAggregates();
    });
    editable.addEventListener("input", (e)=>{
      syncStepHtml(step.id, editable);
      updateLiveAggregates();
      if(e.data === "@") handleAtSign(step.id, editable);
    });
    editable.addEventListener("focus", ()=> state.activeStepId = step.id);
  });
}
function syncStepHtml(stepId, editableEl){
  const step = state.draft.steps.find(s=>s.id===stepId);
  if(step) step.html = editableEl.innerHTML;
}

function handleAtSign(stepId, editableEl){
  const sel = window.getSelection();
  if(!sel.rangeCount) return;
  const range = sel.getRangeAt(0).cloneRange();
  try{
    if(range.startContainer.nodeType === 3 && range.startOffset > 0){
      range.setStart(range.startContainer, range.startOffset - 1);
      range.deleteContents();
    }
  }catch(err){}
  sel.removeAllRanges(); sel.addRange(range);
  state.savedRange = range.cloneRange();
  state.activeStepId = stepId;
  openAtMenu(editableEl);
}
function removeMiniPopups(){ document.querySelectorAll(".mini-popup").forEach(p=>p.remove()); }
function openAtMenu(anchorEl){
  removeMiniPopups();
  const pos = popupPositionNear(anchorEl);
  const pop = document.createElement("div");
  pop.className = "mini-popup"; pop.style.top = pos.top+"px"; pop.style.left = pos.left+"px";
  pop.innerHTML = `<div class="opt-row"><button class="opt" id="opt-food">🥕 Aliment</button><button class="opt" id="opt-tool">🔧 Ustensile</button></div>`;
  document.body.appendChild(pop);
  pop.querySelector("#opt-food").addEventListener("click", ()=> openIngredientForm(pos));
  pop.querySelector("#opt-tool").addEventListener("click", ()=> openToolForm(pos));
}
function openIngredientForm(pos){
  removeMiniPopups();
  const pop = document.createElement("div");
  pop.className = "mini-popup"; pop.style.top = pos.top+"px"; pop.style.left = pos.left+"px";
  pop.innerHTML = `
    <label class="mini-label">Aliment</label>
    <div class="row2"><input type="number" id="ing-qty" placeholder="Quantité" step="0.1" min="0">
      <select id="ing-unit"><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option>
      <option value="l">l</option><option value="cl">cl</option><option value="cuillère à soupe">c. à soupe</option>
      <option value="cuillère à café">c. à café</option><option value="pincée">pincée</option><option value="pièce">pièce</option></select></div>
    <input type="text" id="ing-name" placeholder="Nom de l'aliment">
    <div id="ing-preview" class="mini-preview"></div>
    <button class="confirm-btn" id="ing-confirm">Ajouter</button>`;
  document.body.appendChild(pop);
  const qtyI = pop.querySelector("#ing-qty"), unitI = pop.querySelector("#ing-unit"), nameI = pop.querySelector("#ing-name"), prev = pop.querySelector("#ing-preview");
  const updatePreview = ()=>{
    const qty = parseFloat(qtyI.value)||0, name = nameI.value.trim();
    prev.textContent = name ? "Aperçu : " + buildIngredientDisplayText(name, qty, unitI.value) : "";
  };
  [qtyI, unitI, nameI].forEach(i=>i.addEventListener("input", updatePreview));
  nameI.focus();
  pop.querySelector("#ing-confirm").addEventListener("click", ()=>{
    const name = nameI.value.trim(), qty = parseFloat(qtyI.value)||0, unit = unitI.value;
    if(!name){ nameI.focus(); return; }
    const display = buildIngredientDisplayText(name, qty, unit);
    const html = `<span class="tag tag-ing" contenteditable="false" data-type="ing" data-name="${escapeAttr(name)}" data-qty="${qty}" data-unit="${escapeAttr(unit)}">🥕 ${escapeHtml(display)}</span>&nbsp;`;
    insertHtmlAtSavedRange(html); removeMiniPopups();
  });
}
function openToolForm(pos){
  removeMiniPopups();
  const pop = document.createElement("div");
  pop.className = "mini-popup"; pop.style.top = pos.top+"px"; pop.style.left = pos.left+"px";
  pop.innerHTML = `<label class="mini-label">Ustensile</label><input type="text" id="tool-name" placeholder="Nom (ex: batteur électrique)"><button class="confirm-btn" id="tool-confirm">Ajouter</button>`;
  document.body.appendChild(pop);
  const nameI = pop.querySelector("#tool-name"); nameI.focus();
  pop.querySelector("#tool-confirm").addEventListener("click", ()=>{
    const name = nameI.value.trim();
    if(!name){ nameI.focus(); return; }
    const html = `<span class="tag tag-tool" contenteditable="false" data-type="tool" data-name="${escapeAttr(name)}">🔧 ${escapeHtml(name)}</span>&nbsp;`;
    insertHtmlAtSavedRange(html); removeMiniPopups();
  });
}
function openTimerInsertPopup(anchorEl){
  removeMiniPopups();
  const pos = popupPositionNear(anchorEl);
  const pop = document.createElement("div");
  pop.className = "mini-popup"; pop.style.top = pos.top+"px"; pop.style.left = pos.left+"px";
  pop.innerHTML = `<label class="mini-label">Minuteur</label><input type="text" id="timer-label" placeholder="Libellé (ex: cuisson)">
    <div class="row2"><input type="number" id="timer-min" placeholder="min" min="0"><input type="number" id="timer-sec" placeholder="sec" min="0" max="59"></div>
    <button class="confirm-btn" id="timer-confirm">Insérer</button>`;
  document.body.appendChild(pop);
  pop.querySelector("#timer-label").focus();
  pop.querySelector("#timer-confirm").addEventListener("click", ()=>{
    const label = pop.querySelector("#timer-label").value.trim() || "Minuteur";
    const min = parseInt(pop.querySelector("#timer-min").value)||0, sec = parseInt(pop.querySelector("#timer-sec").value)||0;
    const total = min*60+sec;
    if(total<=0){ toast("Durée invalide"); return; }
    const html = `<span class="tag tag-timer" contenteditable="false" data-type="timer" data-seconds="${total}" data-label="${escapeAttr(label)}">⏱️ ${escapeHtml(label)} (${min}min${sec?sec+"s":""})</span>&nbsp;`;
    insertHtmlAtSavedRange(html); removeMiniPopups();
  });
}
function insertHtmlAtSavedRange(html){
  const editable = document.querySelector(`.step-text[data-step-id="${state.activeStepId}"]`);
  if(!editable) return;
  editable.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  if(state.savedRange) sel.addRange(state.savedRange);
  document.execCommand("insertHTML", false, html);
  syncStepHtml(state.activeStepId, editable);
  updateLiveAggregates();
}
document.addEventListener("click", (e)=>{
  if(!e.target.closest(".mini-popup") && !e.target.closest(".step-toolbar")) removeMiniPopups();
});

function updateLiveAggregates(){
  const ingBox = document.getElementById("ing-box-list"), toolBox = document.getElementById("tool-box-list");
  if(!ingBox) return;
  const ingMap = new Map(), toolMap = new Map();
  document.querySelectorAll("#steps-container .tag-ing").forEach(s=>{
    const key = normalize(s.dataset.name)+"|"+normalize(s.dataset.unit||"");
    if(!ingMap.has(key)) ingMap.set(key, { name:s.dataset.name, unit:s.dataset.unit||"", qty:0 });
    ingMap.get(key).qty += parseFloat(s.dataset.qty)||0;
  });
  document.querySelectorAll("#steps-container .tag-tool").forEach(s=> toolMap.set(normalize(s.dataset.name), s.dataset.name));
  ingBox.innerHTML = ingMap.size ? "" : '<span class="placeholder">Tapez « @ » pour ajouter un aliment.</span>';
  ingMap.forEach(ing=>{
    ingBox.innerHTML += `<li><span>${escapeHtml(ing.name)}</span><span class="qty">${escapeHtml(buildIngredientDisplayText(ing.name, ing.qty, ing.unit))}</span></li>`;
  });
  toolBox.innerHTML = toolMap.size ? "" : '<span class="placeholder">Tapez « @ » pour ajouter un ustensile.</span>';
  toolMap.forEach(name=> toolBox.innerHTML += `<li><span>${escapeHtml(name)}</span></li>`);
}

/* ---- Sauvegarde ---- */
async function saveRecipe(){
  const d = state.draft;
  if(!d.name.trim()){ toast("Donnez un nom à la recette"); return; }
  if(d.steps.length === 0){ toast("Ajoutez au moins une étape"); return; }
  document.querySelectorAll("#steps-container .step-text").forEach(ed=> syncStepHtml(ed.dataset.stepId, ed));

  const payload = {
    name: d.name.trim(), servings: d.servings, prep_time_minutes: d.prep_time_minutes, difficulty: d.difficulty,
    visibility: d.visibility, edit_text_policy: d.edit_text_policy, edit_photo_policy: d.edit_photo_policy
  };
  let recipeId = state.editingId;
  if(!recipeId){
    payload.owner_id = state.session.user.id;
    const { data, error } = await api.recipes.create(payload);
    if(error){ toast("Erreur : " + error.message); return; }
    recipeId = data.id;
  }else{
    const { error } = await api.recipes.update(recipeId, payload);
    if(error){ toast("Erreur : " + error.message); return; }
  }

  if(d.newPhotoBlob){
    const { data: url } = await api.storage.uploadRecipePhoto(recipeId, d.newPhotoBlob.blob, d.newPhotoBlob.ext);
    if(url) await api.recipes.update(recipeId, { photo_url: url });
  }

  await api.content.replaceSteps(recipeId, d.steps);

  const ingMap = new Map(), toolMap = new Map();
  d.steps.forEach(step=>{
    const tmp = document.createElement("div"); tmp.innerHTML = step.html;
    tmp.querySelectorAll(".tag-ing").forEach(s=>{
      const key = normalize(s.dataset.name)+"|"+normalize(s.dataset.unit||"");
      if(!ingMap.has(key)) ingMap.set(key, { name:s.dataset.name, unit:s.dataset.unit||"", qty:0 });
      ingMap.get(key).qty += parseFloat(s.dataset.qty)||0;
    });
    tmp.querySelectorAll(".tag-tool").forEach(s=> toolMap.set(normalize(s.dataset.name), { name:s.dataset.name }));
  });
  const ingredients = Array.from(ingMap.values()).map(i=>({ ...i, display: buildIngredientDisplayText(i.name,i.qty,i.unit) }));
  await api.content.replaceIngredients(recipeId, ingredients);
  await api.content.replaceTools(recipeId, Array.from(toolMap.values()));

  if(d.tags.length){
    const { data: tagRows } = await api.content.ensureTags(d.tags);
    await api.content.setRecipeTags(recipeId, tagRows.map(t=>t.id));
  }else{
    await api.content.setRecipeTags(recipeId, []);
  }

  toast("Recette enregistrée ✅");
  await refreshRecipes();
  goto("home");
}

/* ============================================================================================
   ÉCRAN LECTURE
   ============================================================================================ */
async function openReadScreen(recipeId){
  const { data, error } = await api.recipes.getFull(recipeId);
  if(error){ toast("Recette introuvable ou inaccessible"); return; }
  state.currentRecipe = data;
  state.readServings = data.servings;
  state.doneSteps = new Set();
  goto("read");
}

function isOwner(r){ return r.owner_id === state.session.user.id; }
function canEditText(r){ return isOwner(r) || (r.edit_text_policy === "everyone" && r.visibility !== "private"); }

function renderRead(){
  const r = state.currentRecipe;
  const factor = state.readServings / (r.servings||1);
  const avgRating = (r.recipe_ratings||[]).length ? (r.recipe_ratings.reduce((s,x)=>s+x.stars,0)/r.recipe_ratings.length).toFixed(1) : null;
  const myRating = (r.recipe_ratings||[]).find(x=>x.user_id===state.session.user.id)?.stars || 0;

  root.innerHTML = `
  <div class="back-row"><button id="back-btn">←</button><span>Recette</span>
    ${!isOwner(r) ? `<button class="mini-btn" id="dup-btn" style="margin-left:auto">Dupliquer</button>` : ""}
  </div>
  <div class="read-header">
    ${r.photo_url ? `<div class="read-photo"><img src="${escapeAttr(r.photo_url)}"></div>` : ""}
    <h2>${escapeHtml(r.name)}</h2>
    <div class="card-sub">Créée par ${escapeHtml(r.owner?.username||"?")} le ${formatDate(r.created_at)}. <span class="vis-badge vis-${r.visibility}">${visibilityLabel(r.visibility)}</span></div>
    <div class="card-meta">
      <span class="meta-chip">⏱ ${r.prep_time_minutes?r.prep_time_minutes+" min":"—"}</span>
      <span class="meta-chip">${"●".repeat(r.difficulty||1)}${"○".repeat(5-(r.difficulty||1))} ${DIFFICULTY_LABELS[(r.difficulty||1)-1]}</span>
      ${(r.recipe_tags||[]).map(t=>`<span class="tag-chip">${escapeHtml(t.tags?.label||"")}</span>`).join("")}
    </div>
    <div class="stars-row" id="stars-row">
      ${[1,2,3,4,5].map(n=>`<span class="star ${n<=myRating?"on":""}" data-n="${n}">★</span>`).join("")}
      ${avgRating ? `<span class="hint">(moyenne ${avgRating}/5)</span>` : ""}
    </div>
    <div id="servings-control">
      <span class="label">Pour</span>
      <div class="stepper"><button id="rs-minus" type="button">−</button><div class="val" id="rs-val">${state.readServings}</div><button id="rs-plus" type="button">+</button></div>
      <span class="label">personnes</span>
    </div>
    <div class="read-actions">
      <button class="mini-btn" id="chef-mode-btn">👨‍🍳 Mode Chef</button>
      <button class="mini-btn" id="report-btn">🚩 Signaler</button>
      ${isOwner(r) ? `<button class="mini-btn" id="edit-recipe-btn">✏️ Modifier</button><button class="mini-btn danger" id="delete-recipe-btn">🗑️ Supprimer</button>` : ""}
    </div>
  </div>
  <div class="read-boxes">
    <div class="box" id="read-ing-box"><h4>🥕 Ingrédients</h4><ul id="read-ing-list"></ul></div>
    <div class="box tools"><h4>🔧 Matériel</h4><ul>${(r.recipe_tools||[]).map(t=>`<li><span>${escapeHtml(t.name)}</span></li>`).join("") || '<li class="placeholder">Aucun</li>'}</ul></div>
  </div>
  <div class="read-steps"><h3>Préparation</h3><div id="read-steps-list"></div></div>
  <div class="box history-box" id="history-box"><h4>📝 Historique</h4><div id="history-list"></div>
    <button id="test-btn" type="button">J'ai testé cette recette</button>
    <div id="test-note-area"><textarea id="test-note-input" placeholder="Avis..."></textarea><button id="test-note-save">Enregistrer</button></div>
  </div>
  <div class="box" id="comment-box"><h4>💬 Commentaires</h4><div id="comment-list"></div>
    <div class="comment-form">
      <textarea id="comment-text" placeholder="Votre commentaire..."></textarea>
      <div class="row2">
        <select id="comment-vis">
          ${r.visibility==="public" ? '<option value="public">Public</option>' : ""}
          <option value="friends">Amis</option><option value="private">Privé</option>
        </select>
        <label class="checkbox-row"><input type="checkbox" id="comment-include-owner"> Inclure le propriétaire</label>
      </div>
      <button class="mini-btn" id="comment-send">Publier</button>
    </div>
  </div>`;

  document.getElementById("back-btn").addEventListener("click", ()=>goto("home"));
  document.getElementById("rs-minus").addEventListener("click", ()=>{ state.readServings = Math.max(1,state.readServings-1); refreshRead(); });
  document.getElementById("rs-plus").addEventListener("click", ()=>{ state.readServings = Math.min(50,state.readServings+1); refreshRead(); });
  document.getElementById("chef-mode-btn").addEventListener("click", ()=>{ state.chefStepIndex = 0; goto("chef"); });
  document.getElementById("report-btn").addEventListener("click", ()=> openReportModal(r.id));
  const dup = document.getElementById("dup-btn");
  dup && dup.addEventListener("click", async ()=>{
    const { data, error } = await api.recipes.duplicate(r.id);
    if(error){ toast("Échec de la duplication"); return; }
    toast("Recette dupliquée dans votre espace (privé)");
    await refreshRecipes(); goto("home");
  });
  const editBtn = document.getElementById("edit-recipe-btn");
  editBtn && editBtn.addEventListener("click", ()=> openEditScreen(r));
  const delBtn = document.getElementById("delete-recipe-btn");
  delBtn && delBtn.addEventListener("click", async ()=>{
    if(!confirm("Supprimer définitivement cette recette ?")) return;
    await api.recipes.remove(r.id); await refreshRecipes(); goto("home");
  });
  root.querySelectorAll(".star").forEach(s=>{
    s.addEventListener("click", async ()=>{
      await api.social.setRating(r.id, state.session.user.id, parseInt(s.dataset.n));
      openReadScreen(r.id);
    });
  });

  renderReadIngredients(); renderReadSteps(); renderHistory(); renderComments();

  document.getElementById("test-btn").addEventListener("click", ()=>{ document.getElementById("test-note-area").classList.add("show"); });
  document.getElementById("test-note-save").addEventListener("click", async ()=>{
    const note = document.getElementById("test-note-input").value.trim();
    await api.personal.addHistory(r.id, state.session.user.id, note);
    document.getElementById("test-note-input").value = "";
    document.getElementById("test-note-area").classList.remove("show");
    renderHistory(); toast("Merci pour votre retour 👨‍🍳");
  });
  document.getElementById("comment-send").addEventListener("click", async ()=>{
    const content = document.getElementById("comment-text").value.trim();
    if(!content) return;
    const visibility = document.getElementById("comment-vis").value;
    const includeOwner = document.getElementById("comment-include-owner").checked;
    await api.social.addComment({ recipeId: r.id, authorId: state.session.user.id, content, visibility, includeOwner });
    document.getElementById("comment-text").value = "";
    renderComments();
  });
}
function refreshRead(){
  document.getElementById("rs-val").textContent = state.readServings;
  renderReadIngredients(); renderReadSteps(true);
}
function renderReadIngredients(){
  const r = state.currentRecipe;
  const factor = state.readServings/(r.servings||1);
  const ul = document.getElementById("read-ing-list");
  ul.innerHTML = (r.recipe_ingredients||[]).map(ing=>
    `<li><span>${escapeHtml(ing.name)}</span><span class="qty">${escapeHtml(scaledIngredientText(ing.name, ing.quantity, ing.unit, factor).replace(ing.name,"").trim())}</span></li>`
  ).join("") || '<li class="placeholder">Aucun</li>';
}
function renderReadSteps(keepDone){
  const r = state.currentRecipe;
  const factor = state.readServings/(r.servings||1);
  const container = document.getElementById("read-steps-list");
  if(!keepDone) state.doneSteps = new Set();
  const steps = (r.recipe_steps||[]).slice().sort((a,b)=>a.position-b.position);
  container.innerHTML = "";
  steps.forEach(step=>{
    const tmp = document.createElement("div"); tmp.innerHTML = step.content;
    tmp.querySelectorAll(".tag-ing").forEach(s=>{
      s.textContent = scaledIngredientText(s.dataset.name, parseFloat(s.dataset.qty)||0, s.dataset.unit||"", factor);
    });
    tmp.querySelectorAll(".tag-tool").forEach(s=> s.textContent = s.dataset.name);
    tmp.querySelectorAll(".tag-timer").forEach(s=> s.textContent = "⏱️ " + s.dataset.label);
    const block = document.createElement("div");
    block.className = "read-step" + (state.doneSteps.has(step.id)?" done":"");
    block.innerHTML = `<input type="checkbox" class="step-checkbox" ${state.doneSteps.has(step.id)?"checked":""}><div class="txt">${tmp.innerHTML}</div>`;
    block.querySelector("input").addEventListener("change",(e)=>{
      e.target.checked ? state.doneSteps.add(step.id) : state.doneSteps.delete(step.id);
      block.classList.toggle("done", e.target.checked);
    });
    container.appendChild(block);
  });
  container.querySelectorAll(".tag-timer").forEach(t=>{
    t.addEventListener("click", ()=> openTimerModal(parseInt(t.dataset.seconds), t.dataset.label));
  });
}
async function renderHistory(){
  const r = state.currentRecipe;
  const { data } = await api.personal.listHistory(r.id, state.session.user.id);
  const box = document.getElementById("history-list");
  box.innerHTML = (data&&data.length) ? data.map(h=>`<div class="history-item"><div class="d">${formatDate(h.tested_at)}</div><div>${escapeHtml(h.note||"(pas d’avis)")}</div></div>`).join("") : '<span class="placeholder">Pas encore testée.</span>';
}
async function renderComments(){
  const r = state.currentRecipe;
  const { data } = await api.social.listComments(r.id);
  const box = document.getElementById("comment-list");
  const mine = state.session.user.id;
  box.innerHTML = (data&&data.length) ? data.map(c=>`
    <div class="comment-item">
      ${avatarHtml(c.author,26)}
      <div class="comment-body">
        <b>${escapeHtml(c.author?.username||"?")}</b> <span class="vis-badge vis-${c.visibility}">${visibilityLabel(c.visibility)}</span><br>
        ${escapeHtml(c.content)}
        <div class="comment-actions">
          ${c.author_id === mine
            ? `<button class="mini-link del-comment" data-id="${c.id}">Supprimer</button>`
            : `<button class="mini-link report-comment" data-id="${c.id}">Signaler</button>`}
        </div>
      </div>
    </div>
  `).join("") : '<span class="placeholder">Aucun commentaire.</span>';

  box.querySelectorAll(".del-comment").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      if(!confirm("Supprimer définitivement ce commentaire ?")) return;
      await api.social.deleteComment(btn.dataset.id);
      renderComments();
    });
  });
  box.querySelectorAll(".report-comment").forEach(btn=>{
    btn.addEventListener("click", ()=> openCommentReportModal(btn.dataset.id));
  });
}
function openCommentReportModal(commentId){
  openModal(`<h3>🚩 Signaler ce commentaire</h3><textarea id="report-reason" placeholder="Raison du signalement..." class="modal-textarea"></textarea>
    <button class="primary-btn" id="report-send">Envoyer le signalement</button>`);
  document.getElementById("report-send").addEventListener("click", async ()=>{
    const reason = document.getElementById("report-reason").value.trim();
    await api.social.reportComment(commentId, state.session.user.id, reason);
    closeModal(); toast("Signalement envoyé, merci.");
  });
}
function openReportModal(recipeId){
  openModal(`<h3>🚩 Signaler cette recette</h3><textarea id="report-reason" placeholder="Raison du signalement..." class="modal-textarea"></textarea>
    <button class="primary-btn" id="report-send">Envoyer le signalement</button>`);
  document.getElementById("report-send").addEventListener("click", async ()=>{
    const reason = document.getElementById("report-reason").value.trim();
    await api.social.report(recipeId, state.session.user.id, reason);
    closeModal(); toast("Signalement envoyé, merci.");
  });
}

/* ============================================================================================
   MODE CHEF — pas-à-pas + Wake Lock
   ============================================================================================ */
function renderChef(){
  const r = state.currentRecipe;
  const factor = state.readServings/(r.servings||1);
  const steps = (r.recipe_steps||[]).slice().sort((a,b)=>a.position-b.position);
  const step = steps[state.chefStepIndex];
  document.body.dataset.chefMode = "1";
  requestWakeLock();

  const tmp = document.createElement("div"); tmp.innerHTML = step.content;
  tmp.querySelectorAll(".tag-ing").forEach(s=> s.textContent = scaledIngredientText(s.dataset.name, parseFloat(s.dataset.qty)||0, s.dataset.unit||"", factor));
  tmp.querySelectorAll(".tag-tool").forEach(s=> s.textContent = s.dataset.name);
  tmp.querySelectorAll(".tag-timer").forEach(s=> s.textContent = "⏱️ " + s.dataset.label);

  root.innerHTML = `
  <div class="chef-screen">
    <div class="back-row"><button id="chef-exit">✕</button><span>Étape ${state.chefStepIndex+1} / ${steps.length}</span></div>
    <div class="chef-step-content">${tmp.innerHTML}</div>
    <div class="chef-nav">
      <button class="mini-btn" id="chef-prev" ${state.chefStepIndex===0?"disabled":""}>← Précédent</button>
      <button class="primary-btn" id="chef-next">${state.chefStepIndex===steps.length-1?"Terminer":"Suivant →"}</button>
    </div>
  </div>`;
  root.querySelectorAll(".tag-timer").forEach(t=> t.addEventListener("click", ()=> openTimerModal(parseInt(t.dataset.seconds), t.dataset.label)));
  document.getElementById("chef-exit").addEventListener("click", exitChef);
  document.getElementById("chef-prev").addEventListener("click", ()=>{ state.chefStepIndex--; renderChef(); });
  document.getElementById("chef-next").addEventListener("click", ()=>{
    if(state.chefStepIndex === steps.length-1){ exitChef(); return; }
    state.chefStepIndex++; renderChef();
  });
}
function exitChef(){ releaseWakeLock(); document.body.dataset.chefMode = "0"; goto("read"); }

/* ============================================================================================
   MINUTEUR (modal)
   ============================================================================================ */
function openTimerModal(seconds, label){
  const backdrop = document.getElementById("timer-modal");
  const disp = backdrop.querySelector("#timer-display");
  backdrop.querySelector("#timer-label").textContent = label;
  const render = (rem) => {
    const m = Math.floor(rem/60).toString().padStart(2,"0"), s = (rem%60).toString().padStart(2,"0");
    disp.textContent = m+":"+s;
  };
  render(seconds);
  backdrop.classList.add("show");
  let stop = startTimer(seconds, label, {
    onTick: (rem, done) => { render(rem); if(done) toast("⏱️ " + label + " terminé !"); },
  });
  backdrop.querySelector("#timer-stop").onclick = () => { stop(); backdrop.classList.remove("show"); };
  backdrop.querySelector(".modal-close-bar-timer") && (backdrop.querySelector(".modal-close-bar-timer").onclick = () => { stop(); backdrop.classList.remove("show"); });
}

/* ============================================================================================
   LANCEMENT
   ============================================================================================ */
init();
