# Use uma imagem oficial do Node.js (versão 16 baseada em Alpine para ser mais leve)
FROM node:16-alpine

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de definição do Node (package.json e package-lock.json, se existirem)
COPY package*.json ./

# Instala as dependências (use --production se não precisar dos devDependencies)
RUN npm install --production

# Copia o restante do código para o diretório de trabalho no container
COPY . .

# Exponha as portas que o servidor usa
EXPOSE 3000 3001

# Comando para iniciar o servidor
CMD ["node", "index.js"]
