import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateClientDto } from './dto/create-client.dto';
import { ListClientsQuery } from './dto/list-clients.query';
import { UpdateKycDto } from './dto/update-kyc.dto';
import { UpdateLimitsDto } from './dto/update-limits.dto';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateClientDto, actor: AuthenticatedUser) {
    try {
      const client = await this.prisma.client.create({
        data: {
          fullName: dto.fullName,
          clientType: dto.clientType,
          nationalIdOrReg: dto.nationalIdOrReg,
          phone: dto.phone,
          address: dto.address,
          dailyLimitUsd: dto.dailyLimitUsd,
          creditLimitUsd: dto.creditLimitUsd,
          whatsappOptIn: dto.whatsappOptIn ?? false,
        },
      });

      await this.audit.record({
        entityType: 'Client',
        entityId: client.id,
        action: 'CREATE',
        actorId: actor.id,
        after: client,
      });

      return client;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        throw new ConflictException('يوجد عميل مسجّل مسبقًا بنفس الرقم الوطني/السجل أو رقم الهاتف');
      }
      throw error;
    }
  }

  async findAll(query: ListClientsQuery) {
    const where: Prisma.ClientWhereInput = {
      ...(query.riskTier && { riskTier: query.riskTier }),
      ...(query.kycStatus && { kycStatus: query.kycStatus }),
      ...(query.search && {
        OR: [
          { fullName: { contains: query.search, mode: 'insensitive' } },
          { nationalIdOrReg: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.client.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { balances: { include: { currency: true } } },
      }),
      this.prisma.client.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOne(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { balances: { include: { currency: true } } },
    });
    if (!client) throw new NotFoundException('العميل غير موجود');
    return client;
  }

  async updateLimits(id: string, dto: UpdateLimitsDto, actor: AuthenticatedUser) {
    const before = await this.findOne(id);

    const after = await this.prisma.client.update({
      where: { id },
      data: { dailyLimitUsd: dto.dailyLimitUsd, creditLimitUsd: dto.creditLimitUsd },
    });

    await this.audit.record({
      entityType: 'Client',
      entityId: id,
      action: 'UPDATE_LIMITS',
      actorId: actor.id,
      before: { dailyLimitUsd: before.dailyLimitUsd, creditLimitUsd: before.creditLimitUsd },
      after: {
        dailyLimitUsd: after.dailyLimitUsd,
        creditLimitUsd: after.creditLimitUsd,
        reason: dto.reason,
      },
    });

    return after;
  }

  async updateKyc(id: string, dto: UpdateKycDto, actor: AuthenticatedUser) {
    const before = await this.findOne(id);

    const after = await this.prisma.client.update({
      where: { id },
      data: { kycStatus: dto.kycStatus, riskTier: dto.riskTier },
    });

    await this.audit.record({
      entityType: 'Client',
      entityId: id,
      action: 'UPDATE_KYC',
      actorId: actor.id,
      before: { kycStatus: before.kycStatus, riskTier: before.riskTier },
      after: { kycStatus: after.kycStatus, riskTier: after.riskTier, reason: dto.reason },
    });

    return after;
  }
}
