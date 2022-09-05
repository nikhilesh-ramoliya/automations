# User Feature

- Each folder inside this directory contains 4 files.
- This feature have basic functionality like sign in, sign up, send email
- swagger.json for swagger ui configuration. This file is mandatory when we create any new feature.
- Controller file for handling logic behind validating request parameters and sending appropiate response. It also contain a function named with initializeFeatureName in which routes are defined.
- Model file as we're using prisma we don't have to write models as the models are already defined in schema.prisma file. But in this project it includes queries like insert, get user, etc.
- Service file contains some business logic.
- To create a new feature, for e.g, to add products then create `products` directory inside features.
