import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditService } from './audit.service';
import { ListAuditLogsQuery } from './dto/list-audit-logs.query';

@ApiTags('سجل التدقيق')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Roles(StaffRole.ADMIN, StaffRole.COMPLIANCE_OFFICER)
  @ApiOperation({ summary: 'سجل التدقيق الكامل — من فعل ماذا ومتى، مع فلترة اختيارية' })
  findAll(@Query() query: ListAuditLogsQuery) {
    return this.auditService.findAll(query);
  }
}
