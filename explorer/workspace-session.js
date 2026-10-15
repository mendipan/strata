// Owner management and project authoring use independent CSRF values. Neither
// cookie/session identifier nor provider credential is accessible to this module.
export async function workspaceSession(owner){
  let actor=null;
  async function request(method,signal){
    const response=await fetch('/studio/actor/session',{method,headers:method==='POST'?{...owner.headers('POST'),'content-type':'application/json'}:{},
      body:method==='POST'?'{}':undefined,credentials:'same-origin',cache:'no-store',signal:signal??AbortSignal.timeout(5000)});
    const data=await response.json();if(!response.ok){actor=null;const error=new Error(data.error?.message??'Authoring sign-in is unavailable.');error.code=data.error?.code;throw error;}
    actor=data.authenticated?data:null;return data;
  }
  try{await request('GET');}catch{actor=null;}
  return {...owner,workspace:true,
    get principalId(){return actor?.principal_id;},
    projectHeaders:method=>method==='POST'&&actor?{'x-studio-csrf':actor.csrf}:{},
    refreshActor:signal=>request('GET',signal),
    useAuthoring:signal=>request('POST',signal),
    reauth:async options=>{const accepted=await owner.reauth(options);if(accepted)actor=null;return accepted;},
    logout:async()=>{actor=null;await owner.logout();},
  };
}
