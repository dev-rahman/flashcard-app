# Flashcard (Anki-style) App — Angular + NestJS + PostgreSQL, with Auth

A full spaced-repetition-style flashcard app: add a word, get its translation and example sentences
automatically, then study your deck with flip/shuffle cards — all behind proper login.

**Architecture used:** the **Controller → Service → Repository layered pattern**, which is the de facto standard
NestJS project structure recommended across the framework's own docs and every current architecture guide —
controllers only handle HTTP, services hold business logic, repositories are the only layer touching the
database [web:38][web:41][web:42]. This is the pattern to describe to a reviewer, rather than "MVC," which
assumes a server-rendered view that doesn't exist in an API + Angular SPA setup.

**Translation data:** MyMemory Translation API (free, no key) for word translation [web:27][web:25], and the
Tatoeba API (free, no key) for real example sentences [web:24][web:23].

**Auth:** JWT access token (short-lived, in-memory) + rotating refresh token (long-lived, `httpOnly` cookie) —
the pattern recommended across current NestJS/Angular auth guides [web:32][web:34][web:35][web:43].

---

## 1. Project layout

```
flashcard-app/
├── backend/                         # NestJS
│   ├── .env
│   └── src/
│       ├── main.ts
│       ├── app.module.ts
│       ├── users/
│       │   ├── user.entity.ts
│       │   ├── users.repository.ts   # repository layer
│       │   ├── users.service.ts      # service layer
│       │   └── users.module.ts
│       ├── auth/
│       │   ├── auth.module.ts
│       │   ├── auth.controller.ts    # controller layer
│       │   ├── auth.service.ts       # service layer
│       │   ├── dto/
│       │   │   ├── register.dto.ts
│       │   │   └── login.dto.ts
│       │   ├── entities/
│       │   │   └── refresh-token.entity.ts
│       │   ├── strategies/
│       │   │   └── jwt.strategy.ts
│       │   ├── guards/
│       │   │   └── jwt-auth.guard.ts
│       │   └── decorators/
│       │       ├── public.decorator.ts
│       │       └── current-user.decorator.ts
│       ├── cards/
│       │   ├── card.entity.ts
│       │   ├── cards.repository.ts
│       │   ├── cards.service.ts
│       │   ├── cards.controller.ts
│       │   ├── cards.module.ts
│       │   └── dto/
│       │       └── create-card.dto.ts
│       └── translation/
│           ├── translation.module.ts
│           ├── translation.service.ts
│           └── translation.controller.ts
└── frontend/                         # Angular (standalone components)
    └── src/app/
        ├── app.config.ts
        ├── app.routes.ts
        ├── core/
        │   ├── models/card.model.ts
        │   ├── services/
        │   │   ├── auth.service.ts
        │   │   ├── card.service.ts
        │   │   └── translation.service.ts
        │   ├── guards/
        │   │   └── auth.guard.ts
        │   └── interceptors/
        │       └── auth.interceptor.ts
        └── features/
            ├── auth/
            │   ├── login.component.ts
            │   └── register.component.ts
            ├── add-card/
            │   ├── add-card.component.ts
            │   └── add-card.component.html
            └── study/
                ├── study.component.ts
                ├── study.component.html
                └── study.component.scss
```

---

## 2. Setup commands

```bash
mkdir flashcard-app && cd flashcard-app

# Backend
nest new backend --package-manager npm
cd backend
npm install @nestjs/typeorm typeorm pg @nestjs/config axios @nestjs/axios \
  class-validator class-transformer @nestjs/jwt @nestjs/passport passport \
  passport-jwt bcrypt cookie-parser
npm install -D @types/passport-jwt @types/bcrypt @types/cookie-parser
cd ..

# Frontend
ng new frontend --standalone --routing --style=scss
cd frontend && npm install
```

Postgres via Docker:

```bash
docker run --name flashcard-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=flashcards -p 5432:5432 -d postgres:16
```

`backend/.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASS=postgres
DB_NAME=flashcards
PORT=3000
JWT_ACCESS_SECRET=change-me-access
JWT_REFRESH_SECRET=change-me-refresh
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d
```

---

## 3. Backend — bootstrap

### `src/main.ts`

```ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.enableCors({ origin: 'http://localhost:4200', credentials: true }); // credentials needed for the refresh cookie
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

### `src/app.module.ts`

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { CardsModule } from './cards/cards.module';
import { TranslationModule } from './translation/translation.module';
import { User } from './users/user.entity';
import { RefreshToken } from './auth/entities/refresh-token.entity';
import { Card } from './cards/card.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: +process.env.DB_PORT!,
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      entities: [User, RefreshToken, Card],
      synchronize: true, // fine for a demo/personal project; use migrations in real prod
    }),
    UsersModule,
    AuthModule,
    CardsModule,
    TranslationModule,
  ],
})
export class AppModule {}
```

---

## 4. `users/` module (repository + service layers)

### `user.entity.ts`

```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  passwordHash: string;

  @CreateDateColumn()
  createdAt: Date;
}
```

### `users.repository.ts`

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

@Injectable()
export class UsersRepository {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  findByEmail(email: string) {
    return this.repo.findOne({ where: { email } });
  }

  findById(id: string) {
    return this.repo.findOne({ where: { id } });
  }

  create(email: string, passwordHash: string) {
    const user = this.repo.create({ email, passwordHash });
    return this.repo.save(user);
  }
}
```

### `users.service.ts`

```ts
import { ConflictException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(private readonly usersRepo: UsersRepository) {}

  async register(email: string, password: string) {
    const existing = await this.usersRepo.findByEmail(email);
    if (existing) throw new ConflictException('Email already registered');
    const passwordHash = await bcrypt.hash(password, 12); // 12 rounds, not 4–8 [web:34]
    return this.usersRepo.create(email, passwordHash);
  }

  async validateCredentials(email: string, password: string) {
    const user = await this.usersRepo.findByEmail(email);
    if (!user) return null;
    const valid = await bcrypt.compare(password, user.passwordHash);
    return valid ? user : null;
  }

  findById(id: string) {
    return this.usersRepo.findById(id);
  }
}
```

### `users.module.ts`

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersRepository, UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

---

## 5. `auth/` module

### `entities/refresh-token.entity.ts`

Storing a hash of the refresh token server-side allows revocation and reuse detection, rather than trusting a
stateless refresh JWT alone [web:35][web:45].

```ts
import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../../users/user.entity';

@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tokenHash: string;

  @Column({ default: false })
  revoked: boolean;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;

  @Column()
  userId: string;

  @Column()
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
```

### `dto/register.dto.ts` / `dto/login.dto.ts`

```ts
import { IsEmail, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @MinLength(8)
  password: string;
}
```

```ts
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
```

### `strategies/jwt.strategy.ts`

```ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false, // must reject expired tokens [web:34]
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'), // fail fast if missing [web:40]
    });
  }

  validate(payload: { sub: string; email: string }) {
    return { userId: payload.sub, email: payload.email }; // attached to req.user
  }
}
```

### `decorators/public.decorator.ts` + `guards/jwt-auth.guard.ts`

```ts
import { SetMetadata } from '@nestjs/common';
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

```ts
import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
```

### `decorators/current-user.decorator.ts`

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.user; // { userId, email } set by JwtStrategy.validate
});
```

### `auth.service.ts`

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { RefreshToken } from './entities/refresh-token.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(RefreshToken) private readonly refreshRepo: Repository<RefreshToken>,
  ) {}

  async register(email: string, password: string) {
    const user = await this.usersService.register(email, password);
    return this.issueTokens(user.id, user.email);
  }

  async login(email: string, password: string) {
    const user = await this.usersService.validateCredentials(email, password);
    if (!user) throw new UnauthorizedException('Invalid credentials'); // same message either way [web:34]
    return this.issueTokens(user.id, user.email);
  }

  async refresh(rawToken: string) {
    const tokenHash = this.hash(rawToken);
    const stored = await this.refreshRepo.findOne({ where: { tokenHash }, relations: ['user'] });

    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    stored.revoked = true; // rotation: used token can never be replayed [web:34][web:45]
    await this.refreshRepo.save(stored);

    return this.issueTokens(stored.user.id, stored.user.email);
  }

  async logout(rawToken: string) {
    const tokenHash = this.hash(rawToken);
    await this.refreshRepo.update({ tokenHash }, { revoked: true });
  }

  private async issueTokens(userId: string, email: string) {
    const accessToken = this.jwtService.sign(
      { sub: userId, email },
      {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_EXPIRES', '15m'),
      },
    );

    const rawRefreshToken = this.jwtService.sign(
      { sub: userId },
      {
        secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
        expiresIn: this.config.get('JWT_REFRESH_EXPIRES', '7d'),
      },
    );

    await this.refreshRepo.save(
      this.refreshRepo.create({
        userId,
        tokenHash: this.hash(rawRefreshToken),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    );

    return { accessToken, refreshToken: rawRefreshToken, email };
  }

  private hash(token: string) {
    return bcrypt.hashSync(token, 8); // cheaper rounds are fine, it's not a login password
  }
}
```

### `auth.controller.ts`

```ts
import { Body, Controller, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Public } from './decorators/public.decorator';

const REFRESH_COOKIE = 'refresh_token';
const cookieOptions = {
  httpOnly: true,        // never readable by JS -> not exposed to XSS [web:34][web:43]
  secure: false,          // set true behind HTTPS in production
  sameSite: 'strict' as const,
  path: '/auth',
};

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken, email } = await this.authService.register(dto.email, dto.password);
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions);
    return { accessToken, email };
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken, email } = await this.authService.login(dto.email, dto.password);
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions);
    return { accessToken, email };
  }

  @Public()
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException();
    const { accessToken, refreshToken, email } = await this.authService.refresh(token);
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions);
    return { accessToken, email };
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) await this.authService.logout(token);
    res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
    return { success: true };
  }
}
```

### `auth.module.ts`

```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RefreshToken } from './entities/refresh-token.entity';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([RefreshToken]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard }, // protects every route by default [web:31]
  ],
  exports: [AuthService],
})
export class AuthModule {}
```

---

## 6. `cards/` module (scoped to the logged-in user from the start)

### `card.entity.ts`

```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('cards')
export class Card {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string; // owner, taken from the verified JWT — never from the request body

  @Column()
  word: string;

  @Column()
  translation: string;

  @Column({ default: 'en' })
  sourceLang: string;

  @Column({ default: 'de' })
  targetLang: string;

  @Column('text', { array: true, default: [] })
  examples: string[];

  @Column({ default: 0 })
  timesReviewed: number;

  @CreateDateColumn()
  createdAt: Date;
}
```

### `dto/create-card.dto.ts`

```ts
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

export class CreateCardDto {
  @IsString()
  word: string;

  @IsString()
  translation: string;

  @IsIn(['en', 'de'])
  sourceLang: string;

  @IsIn(['en', 'de'])
  targetLang: string;

  @IsOptional()
  @IsArray()
  examples?: string[];
}
```

### `cards.repository.ts`

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Card } from './card.entity';

@Injectable()
export class CardsRepository {
  constructor(@InjectRepository(Card) private readonly repo: Repository<Card>) {}

  findAllForUser(userId: string) {
    return this.repo.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  findOneForUser(id: string, userId: string) {
    return this.repo.findOne({ where: { id, userId } });
  }

  create(userId: string, data: Partial<Card>) {
    const card = this.repo.create({ ...data, userId });
    return this.repo.save(card);
  }

  async remove(id: string, userId: string) {
    return this.repo.delete({ id, userId });
  }

  incrementReview(id: string, userId: string) {
    return this.repo.increment({ id, userId }, 'timesReviewed', 1);
  }
}
```

### `cards.service.ts`

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { CardsRepository } from './cards.repository';
import { CreateCardDto } from './dto/create-card.dto';

@Injectable()
export class CardsService {
  constructor(private readonly cardsRepo: CardsRepository) {}

  findAll(userId: string) {
    return this.cardsRepo.findAllForUser(userId);
  }

  async findOne(id: string, userId: string) {
    const card = await this.cardsRepo.findOneForUser(id, userId);
    if (!card) throw new NotFoundException('Card not found');
    return card;
  }

  create(userId: string, dto: CreateCardDto) {
    return this.cardsRepo.create(userId, dto);
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId); // 404s if it's not yours
    return this.cardsRepo.remove(id, userId);
  }

  async incrementReview(id: string, userId: string) {
    await this.cardsRepo.incrementReview(id, userId);
    return this.findOne(id, userId);
  }

  /** Fisher–Yates shuffle server-side, scoped to this user's deck */
  async findShuffled(userId: string) {
    const cards = await this.findAll(userId);
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }
}
```

### `cards.controller.ts`

```ts
import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CardsService } from './cards.service';
import { CreateCardDto } from './dto/create-card.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

type AuthUser = { userId: string; email: string };

@Controller('cards')
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.cardsService.findAll(user.userId);
  }

  @Get('shuffle')
  findShuffled(@CurrentUser() user: AuthUser) {
    return this.cardsService.findShuffled(user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.cardsService.findOne(id, user.userId);
  }

  @Post()
  create(@Body() dto: CreateCardDto, @CurrentUser() user: AuthUser) {
    return this.cardsService.create(user.userId, dto);
  }

  @Patch(':id/review')
  review(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.cardsService.incrementReview(id, user.userId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.cardsService.remove(id, user.userId);
  }
}
```

### `cards.module.ts`

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Card } from './card.entity';
import { CardsRepository } from './cards.repository';
import { CardsService } from './cards.service';
import { CardsController } from './cards.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Card])],
  controllers: [CardsController],
  providers: [CardsRepository, CardsService],
})
export class CardsModule {}
```

---

## 7. `translation/` module (public — no user data involved)

### `translation.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class TranslationService {
  constructor(private readonly http: HttpService) {}

  async translate(word: string, sourceLang: string, targetLang: string) {
    const { data } = await firstValueFrom(
      this.http.get('https://api.mymemory.translated.net/get', {
        params: { q: word, langpair: `${sourceLang}|${targetLang}` },
      }),
    );
    return data?.responseData?.translatedText ?? '';
  }

  async getExamples(word: string, sourceLang: string): Promise<string[]> {
    try {
      const { data } = await firstValueFrom(
        this.http.get('https://api.tatoeba.org/unstable/sentences', {
          params: { lang: sourceLang, q: word, sort: 'relevance' },
        }),
      );
      const items = data?.data ?? [];
      return items.slice(0, 3).map((s: any) => s.text);
    } catch {
      return []; // never let a flaky third-party API break card creation
    }
  }

  async translateWithExamples(word: string, sourceLang: string, targetLang: string) {
    const [translation, examples] = await Promise.all([
      this.translate(word, sourceLang, targetLang),
      this.getExamples(word, sourceLang),
    ]);
    return { word, translation, sourceLang, targetLang, examples };
  }
}
```

### `translation.controller.ts`

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { TranslationService } from './translation.service';
import { Public } from '../auth/decorators/public.decorator';

@Controller('translate')
export class TranslationController {
  constructor(private readonly translationService: TranslationService) {}

  @Public()
  @Get()
  translate(
    @Query('word') word: string,
    @Query('source') source = 'en',
    @Query('target') target = 'de',
  ) {
    return this.translationService.translateWithExamples(word, source, target);
  }
}
```

### `translation.module.ts`

```ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TranslationService } from './translation.service';
import { TranslationController } from './translation.controller';

@Module({
  imports: [HttpModule],
  controllers: [TranslationController],
  providers: [TranslationService],
})
export class TranslationModule {}
```

Run the backend: `npm run start:dev` (from `backend/`).

---

## 8. Frontend — models & core services

### `core/models/card.model.ts`

```ts
export interface Card {
  id: string;
  word: string;
  translation: string;
  sourceLang: string;
  targetLang: string;
  examples: string[];
  timesReviewed: number;
  createdAt: string;
}

export interface TranslationPreview {
  word: string;
  translation: string;
  sourceLang: string;
  targetLang: string;
  examples: string[];
}
```

### `core/services/auth.service.ts`

Signal-based state, which is the current recommended pattern over RxJS `BehaviorSubject`s for auth state
[web:33][web:39].

```ts
import { HttpClient } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

interface AuthResponse { accessToken: string; email: string; }

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly base = 'http://localhost:3000/auth';

  private accessToken = signal<string | null>(null); // kept in memory only, never localStorage
  readonly email = signal<string | null>(null);
  readonly isLoggedIn = signal<boolean>(false);

  constructor(private http: HttpClient) {}

  getToken() {
    return this.accessToken();
  }

  register(email: string, password: string): Observable<AuthResponse> {
    return this.http
      .post<AuthResponse>(`${this.base}/register`, { email, password }, { withCredentials: true })
      .pipe(tap((res) => this.setSession(res)));
  }

  login(email: string, password: string): Observable<AuthResponse> {
    return this.http
      .post<AuthResponse>(`${this.base}/login`, { email, password }, { withCredentials: true })
      .pipe(tap((res) => this.setSession(res)));
  }

  refresh(): Observable<AuthResponse> {
    return this.http
      .post<AuthResponse>(`${this.base}/refresh`, {}, { withCredentials: true })
      .pipe(tap((res) => this.setSession(res)));
  }

  logout(): Observable<void> {
    return this.http
      .post<void>(`${this.base}/logout`, {}, { withCredentials: true })
      .pipe(tap(() => this.clearSession()));
  }

  private setSession(res: AuthResponse) {
    this.accessToken.set(res.accessToken);
    this.email.set(res.email);
    this.isLoggedIn.set(true);
  }

  private clearSession() {
    this.accessToken.set(null);
    this.email.set(null);
    this.isLoggedIn.set(false);
  }
}
```

### `core/services/translation.service.ts`

```ts
import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { TranslationPreview } from '../models/card.model';

@Injectable({ providedIn: 'root' })
export class TranslationService {
  private readonly base = 'http://localhost:3000/translate';

  constructor(private http: HttpClient) {}

  preview(word: string, source: string, target: string): Observable<TranslationPreview> {
    return this.http.get<TranslationPreview>(this.base, { params: { word, source, target } });
  }
}
```

### `core/services/card.service.ts`

```ts
import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { Card } from '../models/card.model';

@Injectable({ providedIn: 'root' })
export class CardService {
  private readonly base = 'http://localhost:3000/cards';

  constructor(private http: HttpClient) {}

  getAll(): Observable<Card[]> {
    return this.http.get<Card[]>(this.base);
  }

  getShuffled(): Observable<Card[]> {
    return this.http.get<Card[]>(`${this.base}/shuffle`);
  }

  create(card: Partial<Card>): Observable<Card> {
    return this.http.post<Card>(this.base, card);
  }

  markReviewed(id: string): Observable<Card> {
    return this.http.patch<Card>(`${this.base}/${id}/review`, {});
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}`);
  }
}
```

### `core/interceptors/auth.interceptor.ts`

Attaches the access token to every request and transparently retries once via `/auth/refresh` on a 401
[web:33][web:43].

```ts
import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const isAuthCall = req.url.includes('/auth/');
  const token = auth.getToken();

  const authedReq = !isAuthCall && token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` }, withCredentials: true })
    : req.clone({ withCredentials: true });

  return next(authedReq).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401 && !isAuthCall) {
        return auth.refresh().pipe(
          switchMap(() => {
            const retried = req.clone({
              setHeaders: { Authorization: `Bearer ${auth.getToken()}` },
              withCredentials: true,
            });
            return next(retried);
          }),
        );
      }
      return throwError(() => err);
    }),
  );
};
```

### `core/guards/auth.guard.ts`

```ts
import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isLoggedIn()) return true;
  router.navigate(['/login']);
  return false;
};
```

### `app.config.ts`

```ts
import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
  ],
};
```

### `app.routes.ts`

```ts
import { Routes } from '@angular/router';
import { AddCardComponent } from './features/add-card/add-card.component';
import { StudyComponent } from './features/study/study.component';
import { LoginComponent } from './features/auth/login.component';
import { RegisterComponent } from './features/auth/register.component';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'study', pathMatch: 'full' },
  { path: 'login', component: LoginComponent },
  { path: 'register', component: RegisterComponent },
  { path: 'add', component: AddCardComponent, canActivate: [authGuard] },
  { path: 'study', component: StudyComponent, canActivate: [authGuard] },
];
```

---

## 9. Frontend — auth feature

### `features/auth/login.component.ts`

```ts
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="auth-form">
      <h2>Log in</h2>
      <input [(ngModel)]="email" placeholder="Email" />
      <input [(ngModel)]="password" type="password" placeholder="Password" />
      <button (click)="submit()">Log in</button>
      <p class="error" *ngIf="error">{{ error }}</p>
      <p>No account? <a routerLink="/register">Register</a></p>
    </div>
  `,
})
export class LoginComponent {
  email = '';
  password = '';
  error = '';

  constructor(private auth: AuthService, private router: Router) {}

  submit() {
    this.auth.login(this.email, this.password).subscribe({
      next: () => this.router.navigate(['/study']),
      error: () => (this.error = 'Invalid credentials'),
    });
  }
}
```

### `features/auth/register.component.ts`

```ts
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="auth-form">
      <h2>Create an account</h2>
      <input [(ngModel)]="email" placeholder="Email" />
      <input [(ngModel)]="password" type="password" placeholder="Password (min 8 chars)" />
      <button (click)="submit()">Register</button>
      <p class="error" *ngIf="error">{{ error }}</p>
      <p>Already have an account? <a routerLink="/login">Log in</a></p>
    </div>
  `,
})
export class RegisterComponent {
  email = '';
  password = '';
  error = '';

  constructor(private auth: AuthService, private router: Router) {}

  submit() {
    this.auth.register(this.email, this.password).subscribe({
      next: () => this.router.navigate(['/study']),
      error: () => (this.error = 'Could not register — email may already be in use'),
    });
  }
}
```

---

## 10. Frontend — add-card feature

### `features/add-card/add-card.component.ts`

```ts
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslationService } from '../../core/services/translation.service';
import { CardService } from '../../core/services/card.service';
import { TranslationPreview } from '../../core/models/card.model';

@Component({
  selector: 'app-add-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './add-card.component.html',
})
export class AddCardComponent {
  word = '';
  sourceLang = 'en';
  targetLang = 'de';
  preview: TranslationPreview | null = null;
  loading = false;
  error = '';

  constructor(
    private translationService: TranslationService,
    private cardService: CardService,
    private router: Router,
  ) {}

  fetchPreview() {
    if (!this.word.trim()) return;
    this.loading = true;
    this.error = '';
    this.translationService.preview(this.word.trim(), this.sourceLang, this.targetLang).subscribe({
      next: (res) => { this.preview = res; this.loading = false; },
      error: () => { this.error = 'Translation lookup failed. Try again.'; this.loading = false; },
    });
  }

  saveCard() {
    if (!this.preview) return;
    this.cardService.create(this.preview).subscribe(() => this.router.navigate(['/study']));
  }
}
```

### `features/add-card/add-card.component.html`

```html
<div class="add-card">
  <h2>Add a new flashcard</h2>

  <div class="lang-row">
    <select [(ngModel)]="sourceLang">
      <option value="en">English</option>
      <option value="de">German</option>
    </select>
    <span>&rarr;</span>
    <select [(ngModel)]="targetLang">
      <option value="de">German</option>
      <option value="en">English</option>
    </select>
  </div>

  <input [(ngModel)]="word" placeholder="Enter a word, e.g. 'change'" (keyup.enter)="fetchPreview()" />
  <button (click)="fetchPreview()" [disabled]="loading">
    {{ loading ? 'Looking up...' : 'Translate' }}
  </button>

  <p class="error" *ngIf="error">{{ error }}</p>

  <div class="preview" *ngIf="preview">
    <p><strong>{{ preview.word }}</strong> → <strong>{{ preview.translation }}</strong></p>
    <ul *ngIf="preview.examples.length">
      <li *ngFor="let ex of preview.examples">{{ ex }}</li>
    </ul>
    <button (click)="saveCard()">Save card</button>
  </div>
</div>
```

---

## 11. Frontend — study feature (deck, flip, shuffle, swipe)

### `features/study/study.component.ts`

```ts
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { CardService } from '../../core/services/card.service';
import { Card } from '../../core/models/card.model';

@Component({
  selector: 'app-study',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './study.component.html',
  styleUrl: './study.component.scss',
})
export class StudyComponent implements OnInit {
  cards: Card[] = [];
  index = 0;
  flipped = false;
  dragStartX = 0;
  dragDeltaX = 0;

  constructor(private cardService: CardService) {}

  ngOnInit() {
    this.loadDeck();
  }

  loadDeck() {
    this.cardService.getAll().subscribe((cards) => { this.cards = cards; this.index = 0; });
  }

  shuffle() {
    this.cardService.getShuffled().subscribe((cards) => {
      this.cards = cards;
      this.index = 0;
      this.flipped = false;
    });
  }

  get current(): Card | null {
    return this.cards[this.index] ?? null;
  }

  flip() {
    this.flipped = !this.flipped;
  }

  next() {
    if (!this.current) return;
    this.cardService.markReviewed(this.current.id).subscribe();
    this.flipped = false;
    this.index = (this.index + 1) % this.cards.length;
  }

  prev() {
    this.flipped = false;
    this.index = (this.index - 1 + this.cards.length) % this.cards.length;
  }

  onDragStart(e: MouseEvent | TouchEvent) {
    this.dragStartX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  }

  onDragMove(e: MouseEvent | TouchEvent) {
    const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
    this.dragDeltaX = x - this.dragStartX;
  }

  onDragEnd() {
    if (this.dragDeltaX > 80) this.prev();
    else if (this.dragDeltaX < -80) this.next();
    this.dragDeltaX = 0;
  }
}
```

### `features/study/study.component.html`

```html
<div class="study">
  <div class="toolbar">
    <a routerLink="/add">+ Add card</a>
    <button (click)="shuffle()">🔀 Shuffle</button>
  </div>

  <ng-container *ngIf="current; else empty">
    <div
      class="card"
      [class.flipped]="flipped"
      [style.transform]="'translateX(' + dragDeltaX + 'px)'"
      (click)="flip()"
      (mousedown)="onDragStart($event)"
      (mousemove)="dragStartX && onDragMove($event)"
      (mouseup)="onDragEnd()"
      (touchstart)="onDragStart($event)"
      (touchmove)="onDragMove($event)"
      (touchend)="onDragEnd()"
    >
      <div class="face front" *ngIf="!flipped">
        <h1>{{ current.word }}</h1>
        <small>{{ current.sourceLang }} → {{ current.targetLang }}</small>
      </div>
      <div class="face back" *ngIf="flipped">
        <h1>{{ current.translation }}</h1>
        <ul>
          <li *ngFor="let ex of current.examples">{{ ex }}</li>
        </ul>
      </div>
    </div>

    <div class="nav">
      <button (click)="prev()">⬅ Prev</button>
      <span>{{ index + 1 }} / {{ cards.length }}</span>
      <button (click)="next()">Next ➡</button>
    </div>
  </ng-container>

  <ng-template #empty>
    <p>No cards yet. <a routerLink="/add">Add your first one</a>.</p>
  </ng-template>
</div>
```

### `features/study/study.component.scss`

```scss
.card {
  width: 320px; height: 200px; margin: 2rem auto;
  border-radius: 16px; background: #fff;
  box-shadow: 0 8px 24px rgba(0,0,0,.15);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: transform .15s ease;
  text-align: center; user-select: none;
}
.card .face h1 { margin: 0 0 .5rem; font-size: 1.6rem; }
.card .back ul { text-align: left; font-size: .85rem; color: #555; }
.nav { display: flex; justify-content: center; gap: 1rem; align-items: center; margin-top: 1rem; }
.toolbar { display: flex; justify-content: space-between; padding: 1rem; }
```

---

## 12. Run everything

```bash
# terminal 1
cd backend && npm run start:dev

# terminal 2
cd frontend && ng serve
```

1. Open `http://localhost:4200/register` and create an account.
2. Go to `/add`, type a word, hit **Translate**, then **Save**.
3. Go to `/study` to flip and shuffle through your deck — cards are scoped to your account only.

---

## 13. Why this structure, in one sentence

Each domain gets its own module split into **Controller (HTTP) → Service (business rules) → Repository
(database)**, `auth/` and `users/` never contain flashcard logic, and `cards/` trusts only the `userId` extracted
from the verified JWT — never from the request body — which is the shape a reviewer expects from a properly
layered NestJS + Angular application [web:36][web:38][web:41][web:42].
</content>
