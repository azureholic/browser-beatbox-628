# Stage 1: Build React + TypeScript + Vite SPA
FROM node:22-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Stage 2: Publish ASP.NET Core backend
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS dotnet-build
WORKDIR /src
COPY Directory.Build.props BrowserBeatbox.slnx ./
COPY src/Beatbox.Api/Beatbox.Api.csproj ./src/Beatbox.Api/
RUN dotnet restore src/Beatbox.Api/Beatbox.Api.csproj
COPY src/Beatbox.Api/ ./src/Beatbox.Api/
RUN dotnet publish src/Beatbox.Api/Beatbox.Api.csproj -c Release -o /app/publish -p:SkipSpaBuild=true

# Stage 3: Minimal runtime image
FROM mcr.microsoft.com/dotnet/aspnet:11.0 AS final
WORKDIR /app
COPY --from=dotnet-build /app/publish ./
COPY --from=web-build /web/dist ./wwwroot
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Beatbox.Api.dll"]
