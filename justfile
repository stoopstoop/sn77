default:
  @echo
  @echo " Requires node 20.19.1, ethereum and go "
  @echo " \`nvm install 20.19.1\`"
  @echo " \`nvm use 20.19.1\`"
  @just -l

docker-start:
  docker compose --profile graph up -d --force-recreate
  sleep 3

wait-for-graph-node:
  #!/bin/zsh
  echo "Waiting for Graph Node to be ready..."
  while ! curl -s http://localhost:8070/health > /dev/null; do
    echo "Graph Node not ready yet, waiting..."
    sleep 2
  done
  echo "Graph Node is ready!"

docker-clean:
  docker compose --profile graph down -v --remove-orphans

docker-soft-down:
  docker compose --profile graph down

deploy-subgraph:
  #!/bin/zsh
  cd subgraph
  npm install
  graph codegen
  graph build
  graph create --node http://localhost:8070/ seventy-seven || true
  graph deploy --node http://localhost:8070/ --ipfs http://localhost:5001 seventy-seven --version-label "v0.0.1"

booted-echo:
  @echo "Booted"

clear:
    clear
    
start: docker-start wait-for-graph-node deploy-subgraph clear booted-echo

down: docker-soft-down
