#!/usr/bin/env bash
_ccmux_sessions() {
  ccmux list --json 2>/dev/null | node -e "
    let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try{JSON.parse(d).forEach(s=>console.log(s.name));}catch{}
    });
  "
}

_ccmux() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local prev="${COMP_WORDS[COMP_CWORD-1]}"
  local commands="new list ls close rm swap auto serve merge logs prune doctor init reflect dashboard"

  case "${COMP_WORDS[1]}" in
    close|rm|logs|merge|prune)
      COMPREPLY=($(compgen -W "$(_ccmux_sessions)" -- "$cur"))
      ;;
    swap)
      local projects
      projects=$(node -e "
        const fs=require('fs');
        const cfg=JSON.parse(fs.readFileSync(process.env.HOME+'/.ccmux/config.json','utf8'));
        console.log(Object.keys(cfg.projects).join('\n'));
      " 2>/dev/null)
      COMPREPLY=($(compgen -W "$projects" -- "$cur"))
      ;;
    *)
      COMPREPLY=($(compgen -W "$commands" -- "$cur"))
      ;;
  esac
}

complete -F _ccmux ccmux
