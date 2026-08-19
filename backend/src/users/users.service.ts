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
