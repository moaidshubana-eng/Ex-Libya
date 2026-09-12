import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateBranchStatusDto {
  @ApiProperty({ description: 'فعّال (يظهر في كل قوائم الاختيار التشغيلية) أم معطَّل' })
  @IsBoolean()
  isActive!: boolean;
}
