/* ============================================================================================
   supabase.js — client Supabase + couche API
   Politique "Zéro cookie" : la session est persistée UNIQUEMENT dans localStorage,
   jamais de cookie tiers ni de paramètre d'URL de session.
   ============================================================================================ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ⚠️ À remplacer par les identifiants de votre projet Supabase (Project Settings > API).
// Utilisez la clé "anon public" (ou "publishable" sur les projets récents) — jamais la "service_role".
const SUPABASE_URL = "https://VOTRE-PROJET.supabase.co";
const SUPABASE_ANON_KEY = "VOTRE_CLE_ANON_PUBLIQUE";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: window.localStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

/** Diagnostic de connexion, appelé au démarrage pour afficher un message clair en cas de souci. */
export async function checkConnection(){
  if(SUPABASE_URL.includes("VOTRE-PROJET") || SUPABASE_ANON_KEY.includes("VOTRE_CLE")){
    return { ok:false, message:"Configuration manquante : renseignez SUPABASE_URL et SUPABASE_ANON_KEY dans js/supabase.js." };
  }
  try{
    const { error } = await supabase.from("profiles").select("id").limit(1);
    if(error){
      const msg = error.message || "";
      if(/invalid api key/i.test(msg)) return { ok:false, message:"Clé API invalide. Utilisez la clé « anon public » (ou « publishable »), Project Settings → API — pas la « service_role ». " };
      if(/relation .* does not exist/i.test(msg)) return { ok:false, message:"Base non initialisée : exécutez supabase/migration.sql dans le SQL Editor." };
      return { ok:false, message:"Connexion Supabase : " + msg };
    }
    return { ok:true };
  }catch(err){
    return { ok:false, message:"Connexion Supabase impossible (réseau ou URL incorrecte)." };
  }
}

function ok(data){ return { data, error: null }; }
function fail(error){ console.error(error); return { data: null, error }; }

export const api = {

  /* =========================== AUTHENTIFICATION =========================== */
  auth: {
    async signUp({ email, password, username }){
      const { data, error } = await supabase.auth.signUp({ email, password });
      if(error) return fail(error);
      // Le profil (pseudo unique) est créé juste après, une fois la session active
      const { error: profileErr } = await supabase.from("profiles").insert({ id: data.user.id, username });
      if(profileErr) return fail(profileErr);
      return ok(data);
    },
    async signIn({ email, password }){
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? fail(error) : ok(data);
    },
    async signOut(){
      const { error } = await supabase.auth.signOut();
      return error ? fail(error) : ok(true);
    },
    async getSession(){
      const { data } = await supabase.auth.getSession();
      return data.session;
    },
    onChange(cb){ supabase.auth.onAuthStateChange((_evt, session) => cb(session)); },
    /**
     * Suppression de compte — concession de sécurité assumée (aucune donnée bancaire/personnelle
     * sensible n'est stockée) : on supprime la ligne "profiles" de l'utilisateur, ce qui déclenche
     * en cascade la suppression de toutes ses recettes/commentaires/historique/favoris (contraintes
     * "on delete cascade"), puis on déconnecte. Cela évite de dépendre d'une Edge Function nécessitant
     * la clé service_role. L'entrée technique dans auth.users subsiste (e-mail "réservé") ; si vous
     * voulez une suppression complète de l'utilisateur d'authentification, ajoutez une Edge Function
     * dédiée plus tard (voir INSTRUCTIONS.md).
     */
    async deleteAccount(){
      const { data: { session } } = await supabase.auth.getSession();
      if(!session) return fail(new Error("Non connecté"));
      const { error } = await supabase.from("profiles").delete().eq("id", session.user.id);
      if(error) return fail(error);
      await supabase.auth.signOut();
      return ok(true);
    }
  },

  /* =========================== PROFILS =========================== */
  profiles: {
    async getById(id){
      const { data, error } = await supabase.from("profiles").select("*").eq("id", id).single();
      return error ? fail(error) : ok(data);
    },
    async isUsernameAvailable(username, excludeId=null){
      let q = supabase.from("profiles").select("id").eq("username", username);
      if(excludeId) q = q.neq("id", excludeId);
      const { data, error } = await q;
      if(error) return fail(error);
      return ok(data.length === 0);
    },
    async searchByExactUsername(username){
      const { data, error } = await supabase.from("profiles").select("*").eq("username", username).limit(1);
      return error ? fail(error) : ok(data[0] || null);
    },
    async update(id, patch){
      const { data, error } = await supabase.from("profiles").update(patch).eq("id", id).select().single();
      return error ? fail(error) : ok(data);
    }
  },

  /* =========================== AMIS =========================== */
  friends: {
    async sendRequest(requesterId, addresseeId){
      const { data, error } = await supabase.from("friendships")
        .insert({ requester_id: requesterId, addressee_id: addresseeId, status: "pending" }).select().single();
      return error ? fail(error) : ok(data);
    },
    async respond(friendshipId, accept){
      const { data, error } = await supabase.from("friendships")
        .update({ status: accept ? "accepted" : "declined" }).eq("id", friendshipId).select().single();
      return error ? fail(error) : ok(data);
    },
    async remove(friendshipId){
      const { error } = await supabase.from("friendships").delete().eq("id", friendshipId);
      return error ? fail(error) : ok(true);
    },
    /** Retourne { friends, incoming, outgoing } pour l'utilisateur courant. */
    async listAll(userId){
      const { data, error } = await supabase.from("friendships")
        .select("*, requester:requester_id(username,avatar_url), addressee:addressee_id(username,avatar_url)")
        .or("requester_id.eq." + userId + ",addressee_id.eq." + userId);
      if(error) return fail(error);
      return ok({
        friends: data.filter(f => f.status === "accepted"),
        incoming: data.filter(f => f.status === "pending" && f.addressee_id === userId),
        outgoing: data.filter(f => f.status === "pending" && f.requester_id === userId)
      });
    }
  },

  /* =========================== RECETTES =========================== */
  recipes: {
    async listVisibleToMe(){
      // RLS filtre déjà : privé (moi), amis (si lien accepté), public (non suspendu)
      const { data, error } = await supabase.from("recipes")
        .select("*, owner:owner_id(username,avatar_url), recipe_tags(tags(label))")
        .order("created_at", { ascending: false });
      return error ? fail(error) : ok(data);
    },
    async getFull(recipeId){
      const { data, error } = await supabase.from("recipes")
        .select(`*, owner:owner_id(username,avatar_url),
                  recipe_steps(*), recipe_ingredients(*), recipe_tools(*),
                  recipe_tags(tags(id,label)), recipe_ratings(stars,user_id)`)
        .eq("id", recipeId).single();
      return error ? fail(error) : ok(data);
    },
    async create(payload){
      const { data, error } = await supabase.from("recipes").insert(payload).select().single();
      return error ? fail(error) : ok(data);
    },
    async update(id, patch){
      const { data, error } = await supabase.from("recipes").update(patch).eq("id", id).select().single();
      return error ? fail(error) : ok(data);
    },
    async remove(id){
      const { error } = await supabase.from("recipes").delete().eq("id", id);
      return error ? fail(error) : ok(true);
    },
    /** Clonage sans généalogie — délégué à la fonction SQL duplicate_recipe(). */
    async duplicate(sourceId){
      const { data, error } = await supabase.rpc("duplicate_recipe", { source_id: sourceId });
      return error ? fail(error) : ok(data); // data = nouvel id
    }
  },

  /* =========================== CONTENU (étapes / ingrédients / ustensiles / tags) =========================== */
  content: {
    async replaceSteps(recipeId, steps){
      await supabase.from("recipe_steps").delete().eq("recipe_id", recipeId);
      if(steps.length === 0) return ok([]);
      const rows = steps.map((s, i) => ({ recipe_id: recipeId, position: i, content: s.html }));
      const { data, error } = await supabase.from("recipe_steps").insert(rows).select();
      return error ? fail(error) : ok(data);
    },
    async replaceIngredients(recipeId, ingredients){
      await supabase.from("recipe_ingredients").delete().eq("recipe_id", recipeId);
      if(ingredients.length === 0) return ok([]);
      const rows = ingredients.map(i => ({ recipe_id: recipeId, name: i.name, quantity: i.qty, unit: i.unit, display_text: i.display }));
      const { data, error } = await supabase.from("recipe_ingredients").insert(rows).select();
      return error ? fail(error) : ok(data);
    },
    async replaceTools(recipeId, tools){
      await supabase.from("recipe_tools").delete().eq("recipe_id", recipeId);
      if(tools.length === 0) return ok([]);
      const rows = tools.map(t => ({ recipe_id: recipeId, name: t.name }));
      const { data, error } = await supabase.from("recipe_tools").insert(rows).select();
      return error ? fail(error) : ok(data);
    },
    async ensureTags(labels){
      // upsert des libellés de tags (ex: "Sans gluten", "Rapide", "Végétarien")
      const rows = labels.map(l => ({ label: l }));
      const { data, error } = await supabase.from("tags").upsert(rows, { onConflict: "label" }).select();
      return error ? fail(error) : ok(data);
    },
    async setRecipeTags(recipeId, tagIds){
      await supabase.from("recipe_tags").delete().eq("recipe_id", recipeId);
      if(tagIds.length === 0) return ok([]);
      const rows = tagIds.map(id => ({ recipe_id: recipeId, tag_id: id }));
      const { data, error } = await supabase.from("recipe_tags").insert(rows).select();
      return error ? fail(error) : ok(data);
    },
    async allTags(){
      const { data, error } = await supabase.from("tags").select("*").order("label");
      return error ? fail(error) : ok(data);
    }
  },

  /* =========================== SOCIAL (notes / commentaires / signalements) =========================== */
  social: {
    async setRating(recipeId, userId, stars){
      const { data, error } = await supabase.from("recipe_ratings")
        .upsert({ recipe_id: recipeId, user_id: userId, stars }, { onConflict: "recipe_id,user_id" }).select().single();
      return error ? fail(error) : ok(data);
    },
    async addComment({ recipeId, authorId, content, visibility, includeOwner }){
      const { data, error } = await supabase.from("recipe_comments")
        .insert({ recipe_id: recipeId, author_id: authorId, content, visibility, include_owner: includeOwner }).select().single();
      return error ? fail(error) : ok(data);
    },
    async listComments(recipeId){
      const { data, error } = await supabase.from("recipe_comments")
        .select("*, author:author_id(username,avatar_url)").eq("recipe_id", recipeId).order("created_at");
      return error ? fail(error) : ok(data);
    },
    async report(recipeId, reporterId, reason){
      const { data, error } = await supabase.from("recipe_reports")
        .insert({ recipe_id: recipeId, reporter_id: reporterId, reason }).select().single();
      return error ? fail(error) : ok(data);
    },
    /** Suppression d'un commentaire — la RLS n'autorise que l'auteur du commentaire. */
    async deleteComment(commentId){
      const { error } = await supabase.from("recipe_comments").delete().eq("id", commentId);
      return error ? fail(error) : ok(true);
    },
    async reportComment(commentId, reporterId, reason){
      const { data, error } = await supabase.from("comment_reports")
        .insert({ comment_id: commentId, reporter_id: reporterId, reason }).select().single();
      return error ? fail(error) : ok(data);
    }
  },

  /* =========================== BLOCAGE D'UTILISATEURS =========================== */
  blocks: {
    async block(blockerId, blockedId){
      const { data, error } = await supabase.from("blocks")
        .insert({ blocker_id: blockerId, blocked_id: blockedId }).select().single();
      return error ? fail(error) : ok(data);
    },
    async unblock(blockerId, blockedId){
      const { error } = await supabase.from("blocks").delete().eq("blocker_id", blockerId).eq("blocked_id", blockedId);
      return error ? fail(error) : ok(true);
    },
    async list(blockerId){
      const { data, error } = await supabase.from("blocks")
        .select("*, blocked:blocked_id(id,username,avatar_url)").eq("blocker_id", blockerId);
      return error ? fail(error) : ok(data);
    }
  },

  /* =========================== DONNÉES PERSONNELLES (historique / favoris) =========================== */
  personal: {
    async addHistory(recipeId, userId, note){
      const { data, error } = await supabase.from("recipe_history")
        .insert({ recipe_id: recipeId, user_id: userId, note }).select().single();
      return error ? fail(error) : ok(data);
    },
    async listHistory(recipeId, userId){
      const { data, error } = await supabase.from("recipe_history")
        .select("*").eq("recipe_id", recipeId).eq("user_id", userId).order("tested_at", { ascending: false });
      return error ? fail(error) : ok(data);
    },
    async toggleFavorite(recipeId, userId, isFav){
      if(isFav){
        const { error } = await supabase.from("recipe_favorites").delete().eq("recipe_id", recipeId).eq("user_id", userId);
        return error ? fail(error) : ok(false);
      }else{
        const { error } = await supabase.from("recipe_favorites").insert({ recipe_id: recipeId, user_id: userId });
        return error ? fail(error) : ok(true);
      }
    },
    async listFavoriteIds(userId){
      const { data, error } = await supabase.from("recipe_favorites").select("recipe_id").eq("user_id", userId);
      return error ? fail(error) : ok((data||[]).map(r => r.recipe_id));
    }
  },

  /* =========================== STOCKAGE (avatars / photos de recettes) =========================== */
  storage: {
    async uploadAvatar(userId, blob, ext){
      const path = userId + "/avatar." + ext;
      const { error } = await supabase.storage.from("avatars").upload(path, blob, { upsert: true, contentType: "image/" + ext });
      if(error) return fail(error);
      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      return ok(data.publicUrl);
    },
    async uploadRecipePhoto(recipeId, blob, ext){
      const path = recipeId + "/" + Date.now() + "." + ext;
      const { error } = await supabase.storage.from("recipe-photos").upload(path, blob, { contentType: "image/" + ext });
      if(error) return fail(error);
      const { data } = await supabase.storage.from("recipe-photos").createSignedUrl(path, 60 * 60 * 24 * 7);
      return ok(data.signedUrl);
    }
  }
};
