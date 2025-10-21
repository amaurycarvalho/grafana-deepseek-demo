FROM node:20-alpine

WORKDIR /app

# Instala certificados e dependências básicas
RUN apk add --no-cache ca-certificates

# Copia o package.json
COPY package.json ./

# Instala dependências (sem exigir package-lock.json)
RUN npm install --omit=dev

# Copia o código restante
COPY . .

# Define variáveis de ambiente padrão
ENV PORT=3001
EXPOSE 3001

# Comando de inicialização
CMD ["node", "index.js"]

