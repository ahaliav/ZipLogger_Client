FROM maven:3.9-eclipse-temurin-17 AS build

WORKDIR /src
# Resolve dependencies first so source edits do not re-download Maven Central.
COPY pom.xml ./
RUN mvn -B -q dependency:go-offline

COPY src ./src
RUN mvn -B -q package

FROM eclipse-temurin:17-jre
COPY --from=build /src/target/payments-1.0.0.jar /app/payments.jar
CMD ["java", "-jar", "/app/payments.jar"]
