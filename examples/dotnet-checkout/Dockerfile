FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build

WORKDIR /src
COPY NuGet.config Checkout.csproj ./
RUN dotnet restore

COPY Program.cs ./
RUN dotnet publish -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
# The aspnet runtime image ships neither wget nor curl, so the compose healthcheck
# could never pass and the container sat permanently "unhealthy" while serving fine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "checkout.dll"]
